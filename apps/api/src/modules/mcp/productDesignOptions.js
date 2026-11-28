import { z } from 'zod';
import { ApiError, NotFoundError } from '../../utils/errors.js';
import { CatalogProduct } from '../catalog/catalogProduct.model.js';
import {
  normalizePlaceholder,
  physicalFrameForView,
  placeholderToStagePixels,
  stagePixelsToArtworkPlacement,
} from '../../lib/printCoords.js';
import { catalogProductMongoFilter } from './catalogRead.js';

const PRODUCT_ID = /^[a-fA-F0-9]{24}$/;
const PRINT_METHODS = ['dtf', 'screen_print', 'sublimation', 'uv_print'];

export const PRODUCTS_GET_DESIGN_OPTIONS_DESCRIPTION = [
  'List the decoration areas for one ShelfMerch catalog product before customizing artwork.',
  'Copy decorationAreas[].key into products_prepare_design decorationArea. Do not guess "front" or any other key.',
  'Copy that area defaultPlacement unless the user asked for a different position. The artwork must stay inside the area.',
  'defaultDecorationArea is the editor default, such as Left on a polo. It is not always front.',
  'images and decorationAreas[].imageUrl are product photos. Variants do not have their own photos; colorHex is the swatch.',
  'rendererCompatible means that area can be baked onto its product photo, including left chest, right chest, back, and a custom placement.',
  'A mockup image exists only after the renderer returns one. Chest areas use the front photo when no side photo exists.',
  'Cost, supplier, and margin are not returned.',
].join(' ');

export const productDesignOptionsInputSchema = z.object({
  productId: z.string().trim().regex(PRODUCT_ID, 'productId must be a catalog product id'),
}).strict();

const placementSchema = z.object({
  centerXPercent: z.number(),
  centerYPercent: z.number(),
  widthPercent: z.number(),
  rotationDeg: z.number(),
});

const areaSchema = z.object({
  key: z.string(),
  label: z.string(),
  view: z.enum(['front', 'back', 'left', 'right']),
  isDefault: z.boolean(),
  xIn: z.number(),
  yIn: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  box: z.object({
    xPct: z.number(),
    yPct: z.number(),
    widthPct: z.number(),
    heightPct: z.number(),
  }),
  dpi: z.number(),
  imageUrl: z.string(),
  defaultPlacement: placementSchema,
  rendererCompatible: z.boolean(),
});

export const productDesignOptionsOutputSchema = z.object({
  catalogProductId: z.string(),
  name: z.string(),
  sku: z.string(),
  primaryImageUrl: z.string(),
  images: z.array(z.string()),
  variants: z.array(z.object({
    sku: z.string(),
    color: z.string(),
    colorHex: z.string(),
    size: z.string(),
  })),
  decorationAreas: z.array(areaSchema),
  defaultDecorationArea: z.string(),
});

function mediaPath(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  const path = value.replace(/^https?:\/\/[^/]+/i, '');
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function firstUrl(values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function usableArea(raw) {
  return Number(raw?.widthIn) > 0 || Number(raw?.box?.widthPct) > 0 || Number(raw?.maxWidthCm) > 0;
}

function baseKey(raw, index) {
  const key = String(raw?.key || '').trim();
  if (key) return key;
  const label = String(raw?.label || '').trim();
  if (label) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || `area_${index + 1}`;
  }
  return `area_${index + 1}`;
}

function stableKey(raw, index, siblings) {
  const base = baseKey(raw, index);
  const dupes = siblings
    .map((area, areaIndex) => ({ areaIndex, base: baseKey(area, areaIndex) }))
    .filter((row) => row.base === base);
  if (dupes.length <= 1) return base;
  return index === dupes[0].areaIndex ? base : `${base}__${index}`;
}

function viewUrls(product, view) {
  if (view === 'back') return [product.maskBackImageUrl, product.baseBackImageUrl];
  if (view === 'left') return [product.maskLeftImageUrl, product.baseLeftImageUrl];
  if (view === 'right') return [product.maskRightImageUrl, product.baseRightImageUrl];
  return [product.maskImageUrl, product.baseImageUrl, product.primaryImageUrl, ...(product.imageUrls || [])];
}

function areaView(product, raw) {
  const mockup = mediaPath(raw?.mockupImageUrl);
  if (mockup) {
    for (const view of ['back', 'left', 'right', 'front']) {
      if (viewUrls(product, view).some((url) => mediaPath(url) === mockup)) return view;
    }
  }
  const token = `${raw?.key || ''} ${raw?.label || ''}`.toLowerCase();
  if (/\bback\b/.test(token)) return 'back';
  if (/\bleft\b/.test(token)) return 'left';
  if (/\bright\b/.test(token)) return 'right';
  return 'front';
}

function frontImage(product) {
  return firstUrl([
    product.baseImageUrl,
    product.primaryImageUrl,
    product.imageUrls?.[0],
    product.maskImageUrl,
  ]);
}

/** Photo the baker composites. Side and back photos win; chest areas fall back to the front photo. */
function compositeImage(product, view, raw) {
  if (view === 'front') return frontImage(product);
  return firstUrl([...viewUrls(product, view), raw?.mockupImageUrl]) || frontImage(product);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function defaultPlacementFor(product, raw) {
  const frame = physicalFrameForView(product.physicalDimensions, raw?.key);
  const placeholder = normalizePlaceholder(raw, frame);
  const stage = placeholderToStagePixels(placeholder, frame);
  const fitW = Math.min(stage.w * 0.92, stage.h * 0.92);
  const placed = stagePixelsToArtworkPlacement(
    stage.x + stage.w / 2,
    stage.y + stage.h / 2,
    fitW,
    0,
    stage,
  );
  let width = placed.printWPct;
  if (!Number.isFinite(width) || width <= 0) width = 92;
  width = Math.min(width, 92);
  const half = width / 2;
  const center = (value) => Math.min(100 - half, Math.max(half, Number.isFinite(value) ? value : 50));
  return {
    centerXPercent: round2(center(placed.printCxPct)),
    centerYPercent: round2(center(placed.printCyPct)),
    widthPercent: round2(width),
    rotationDeg: 0,
  };
}

function rendererCanBake(product, raw, placeholder, imageUrl) {
  if (!imageUrl) return false;
  if (raw?.shapeType === 'polygon') return false;
  const methods = Array.isArray(raw?.methods) ? raw.methods : [];
  if (methods.length && !methods.some((method) => PRINT_METHODS.includes(method))) return false;
  const frame = physicalFrameForView(product.physicalDimensions, raw?.key);
  const dpi = placeholder.dpi || Number(product.dpi) || 300;
  const pixels = placeholder.widthIn * placeholder.heightIn * dpi ** 2;
  return placeholder.widthIn > 0
    && placeholder.heightIn > 0
    && Number.isFinite(placeholder.xIn)
    && Number.isFinite(placeholder.yIn)
    && pixels > 0
    && pixels <= 16_000_000
    && placeholder.xIn >= 0
    && placeholder.yIn >= 0
    && placeholder.xIn + placeholder.widthIn <= frame.width + 0.001
    && placeholder.yIn + placeholder.heightIn <= frame.height + 0.001;
}

function productImages(product) {
  const images = [];
  const seen = new Set();
  const push = (url) => {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value || seen.has(value)) return;
    seen.add(value);
    images.push(value);
  };
  push(product.primaryImageUrl);
  for (const url of product.imageUrls || []) push(url);
  push(product.baseImageUrl);
  return images;
}

/** Stable decoration areas. Keys match the swag editor, including front__1 for duplicate catalog keys. */
export function listDesignAreas(product) {
  const raws = (product?.printAreas || []).filter(usableArea);
  const drafted = raws.map((raw, index) => {
    const view = areaView(product, raw);
    const frame = physicalFrameForView(product.physicalDimensions, raw?.key);
    const placeholder = normalizePlaceholder(raw, frame);
    return {
      raw,
      key: stableKey(raw, index, raws),
      label: String(raw.label || placeholder.label || stableKey(raw, index, raws)),
      view,
      placeholder,
      imageUrl: compositeImage(product, view, raw),
      designImageUrl: compositeImage(product, view, raw),
    };
  });
  const defaultKey = preferredDefaultKey(drafted);
  return drafted.map((area) => ({
    key: area.key,
    label: area.label,
    view: area.view,
    isDefault: area.key === defaultKey,
    xIn: area.placeholder.xIn,
    yIn: area.placeholder.yIn,
    widthIn: area.placeholder.widthIn,
    heightIn: area.placeholder.heightIn,
    box: {
      xPct: area.placeholder.box.xPct,
      yPct: area.placeholder.box.yPct,
      widthPct: area.placeholder.box.widthPct,
      heightPct: area.placeholder.box.heightPct,
    },
    dpi: area.placeholder.dpi,
    imageUrl: area.imageUrl,
    designImageUrl: area.designImageUrl,
    defaultPlacement: defaultPlacementFor(product, area.raw),
    rendererCompatible: rendererCanBake(
      product,
      area.raw,
      area.placeholder,
      area.designImageUrl,
    ),
  }));
}

function preferredDefaultKey(areas) {
  const left = areas.find((area) => /\bleft\b/.test(`${area.raw?.key || ''} ${area.raw?.label || ''}`.toLowerCase()));
  if (left) return left.key;
  const front = areas.find((area) => area.view === 'front');
  if (front) return front.key;
  return areas[0]?.key || '';
}

export function presentDesignOptions(product) {
  const areas = listDesignAreas(product).map(({ designImageUrl: _designImageUrl, ...area }) => area);
  const images = productImages(product);
  return {
    catalogProductId: String(product._id),
    name: product.name || '',
    sku: product.sku || '',
    primaryImageUrl: images[0] || '',
    images,
    variants: (product.variants || []).filter((variant) => variant.enabled !== false).map((variant) => ({
      sku: variant.sku || '',
      color: variant.color || '',
      colorHex: variant.colorHex || '',
      size: variant.size || '',
    })),
    decorationAreas: areas,
    defaultDecorationArea: areas.find((area) => area.isDefault)?.key || '',
  };
}

export async function getProductDesignOptions(productId) {
  const product = await CatalogProduct.findOne(catalogProductMongoFilter(productId)).lean();
  if (!product) throw new NotFoundError('Catalog product not found');
  return presentDesignOptions(product);
}

export function productDesignOptionsText(output) {
  const lines = (output.decorationAreas || []).map((area) => [
    area.key,
    area.label,
    area.view,
    area.isDefault ? 'default' : 'optional',
    `${area.widthIn} x ${area.heightIn} in`,
    `placement ${area.defaultPlacement.centerXPercent},${area.defaultPlacement.centerYPercent} width ${area.defaultPlacement.widthPercent}`,
  ].join(' | '));
  return [
    `${output.name} decoration areas. Copy a key into products_prepare_design. Do not guess front.`,
    output.defaultDecorationArea ? `Default key: ${output.defaultDecorationArea}` : 'This product has no decoration areas.',
    ...lines,
  ].join('\n');
}

export function productDesignOptionsError(error, fallback) {
  if (error?.code === 'NOT_FOUND') return 'That catalog product was not found.';
  if (error?.code === 'VALIDATION') return error.message || 'Catalog product id is not valid.';
  return fallback;
}

export function assertDesignProductId(productId) {
  const parsed = productDesignOptionsInputSchema.safeParse({ productId });
  if (!parsed.success) throw new ApiError(400, 'Catalog product id is not valid', 'VALIDATION');
  return parsed.data.productId;
}
