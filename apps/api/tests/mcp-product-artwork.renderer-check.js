import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import PNG from 'png-js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './setup.js';
import { makeTenant, makeUser } from './helpers.js';
import { png } from './fixtures/swagArtwork.js';
import { CatalogProduct } from '../src/modules/catalog/catalogProduct.model.js';
import { Collection } from '../src/modules/collections/collection.model.js';
import { Shop } from '../src/modules/shops/shop.model.js';
import { LOCAL_UPLOAD_DIR } from '../src/services/storage.service.js';
import { completeShopAssetUpload } from '../src/modules/mcp/shopsAssetUpload.js';
import {
  executeProductArtworkDesign,
  prepareProductArtworkDesign,
  prepareProductArtworkUpload,
} from '../src/modules/mcp/productArtworkWrite.js';
import { getProductDesignOptions } from '../src/modules/mcp/productDesignOptions.js';

let tenant;
let admin;
let shop;
let folder;
const previousExecutable = process.env.SWAG_RENDERER_EXECUTABLE;

beforeAll(async () => {
  if (!process.env.SWAG_RENDERER_EXECUTABLE) {
    throw new Error('Set SWAG_RENDERER_EXECUTABLE to an installed browser for real mockup acceptance.');
  }
  await connectTestDb();
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  folder = await fs.mkdtemp(path.join(LOCAL_UPLOAD_DIR, 'mcp-artwork-render-'));
  await fs.writeFile(path.join(folder, 'front.png'), png(400, 520, [230, 230, 230, 255]));
  await fs.writeFile(path.join(folder, 'back.png'), png(400, 520, [20, 40, 190, 255]));
  await fs.writeFile(path.join(folder, 'mug.png'), png(360, 360, [245, 236, 210, 255]));
  await fs.writeFile(path.join(folder, 'tee.png'), png(400, 480, [250, 250, 250, 255]));
});

afterAll(async () => {
  await disconnectTestDb();
  if (folder && path.dirname(folder) === LOCAL_UPLOAD_DIR && path.basename(folder).startsWith('mcp-artwork-render-')) {
    await fs.rm(folder, { recursive: true, force: true });
  }
  if (previousExecutable === undefined) delete process.env.SWAG_RENDERER_EXECUTABLE;
  else process.env.SWAG_RENDERER_EXECUTABLE = previousExecutable;
});

beforeEach(async () => {
  await clearTestDb();
  tenant = await makeTenant();
  admin = await makeUser(tenant, 'company_admin');
  shop = await Shop.create({
    tenantId: tenant._id,
    name: 'HQ Store',
    slug: `hq-render-${Date.now()}`,
    status: 'live',
    activeListingKeys: ['keep:listing'],
  });
});

function imageUrl(name) {
  return `/uploads/${path.basename(folder)}/${name}`;
}

function actor() {
  return { tenantId: tenant._id, actorUserId: admin.user._id };
}

async function uploadArtwork() {
  const prepared = await prepareProductArtworkUpload({
    ...actor(),
    input: { originalName: 'mark.png' },
  });
  const artwork = png(64, 64, [230, 20, 20, 255], 600);
  const completed = await completeShopAssetUpload({
    ticketId: prepared.ticketId,
    uploadToken: prepared.uploadToken,
    file: { buffer: artwork, originalname: 'mark.png', mimetype: 'image/png' },
  });
  return { ticketId: prepared.ticketId, artwork };
}

async function previewDesign({ name, productId, ticketId, area, placement, variant }) {
  return prepareProductArtworkDesign({
    ...actor(),
    input: {
      shopId: String(shop._id),
      name,
      catalogProductId: productId,
      artworkTicketId: ticketId,
      decorationArea: area,
      placement,
      ...(variant ? { variant } : {}),
    },
  });
}

async function readUpload(url) {
  const file = path.resolve(LOCAL_UPLOAD_DIR, String(url).replace(/^\/uploads\//, ''));
  return fs.readFile(file);
}

function decodePng(buffer) {
  const image = new PNG(buffer);
  return new Promise((resolve, reject) => {
    try {
      image.decode((pixels) => resolve({ width: image.width, height: image.height, pixels }));
    } catch (error) {
      reject(error);
    }
  });
}

function inkBox(decoded, predicate) {
  const { width, height, pixels } = decoded;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (!predicate(pixels, index)) continue;
      count += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    count,
    cx: count ? sumX / count : 0,
    cy: count ? sumY / count : 0,
    w: count ? maxX - minX + 1 : 0,
    h: count ? maxY - minY + 1 : 0,
  };
}

const isRed = (pixels, index) => pixels[index] > 140
  && pixels[index] > pixels[index + 1] + 60
  && pixels[index] > pixels[index + 2] + 60
  && pixels[index + 3] > 128;

const isBlue = (pixels, index) => pixels[index + 2] > 120
  && pixels[index + 2] > pixels[index] + 50
  && pixels[index + 3] > 128;

it('bakes real ActiveDry Polo, mug, and split-tee mockups and saves a draft', async () => {
  const front = imageUrl('front.png');
  const back = imageUrl('back.png');
  const polo = await CatalogProduct.create({
    sku: `POLO-${Date.now()}`,
    name: 'ActiveDry Polo',
    category: 'Apparel',
    group: 'polo',
    basePriceInr: 840,
    primaryImageUrl: front,
    baseImageUrl: front,
    baseBackImageUrl: back,
    physicalDimensions: { width: 20, height: 26, length: 18 },
    printAreas: [
      { key: 'right', label: 'Right chest', xIn: 2, yIn: 4, widthIn: 3.5, heightIn: 3.5, dpi: 300, methods: ['dtf'] },
      { key: 'left', label: 'Left chest', xIn: 14, yIn: 4, widthIn: 3.5, heightIn: 3.5, dpi: 300, methods: ['dtf'] },
      { key: 'back', label: 'Back', xIn: 6, yIn: 5, widthIn: 8, heightIn: 10, dpi: 300, methods: ['dtf'] },
    ],
    variants: [{ sku: 'POLO-BLK-L', color: 'Black', colorHex: '#111111', size: 'L', enabled: true }],
  });
  const mug = await CatalogProduct.create({
    sku: `MUG-${Date.now()}`,
    name: 'Camp Mug',
    category: 'Drinkware',
    group: 'mug',
    basePriceInr: 300,
    primaryImageUrl: imageUrl('mug.png'),
    baseImageUrl: imageUrl('mug.png'),
    physicalDimensions: { width: 12, height: 10, length: 12 },
    printAreas: [{ key: 'wrap', label: 'Wrap', xIn: 1, yIn: 2, widthIn: 8, heightIn: 3, dpi: 300, methods: ['sublimation'] }],
    variants: [{ sku: 'MUG-WHT', color: 'White', colorHex: '#ffffff', size: 'OS', enabled: true }],
  });
  const tee = await CatalogProduct.create({
    sku: `TEE-${Date.now()}`,
    name: 'Split Tee',
    category: 'Apparel',
    group: 'tee',
    basePriceInr: 500,
    primaryImageUrl: imageUrl('tee.png'),
    baseImageUrl: imageUrl('tee.png'),
    physicalDimensions: { width: 20, height: 24, length: 18 },
    printAreas: [
      { key: 'front', label: 'Chest', xIn: 7, yIn: 4, widthIn: 4, heightIn: 4, dpi: 300, methods: ['dtf'] },
      { key: 'front', label: 'Hem', xIn: 7, yIn: 16, widthIn: 4, heightIn: 2, dpi: 300, methods: ['dtf'] },
    ],
  });

  const poloOptions = await getProductDesignOptions(String(polo._id));
  expect(poloOptions.decorationAreas.map((area) => area.key)).toEqual(['right', 'left', 'back']);
  expect(poloOptions.defaultDecorationArea).toBe('left');
  expect(poloOptions.decorationAreas.every((area) => area.rendererCompatible)).toBe(true);
  expect(poloOptions.decorationAreas.find((area) => area.key === 'back').imageUrl).toBe(back);
  const { ticketId, artwork } = await uploadArtwork();
  const actorInput = actor();
  await expect(prepareProductArtworkDesign({
    ...actorInput,
    input: {
      shopId: String(shop._id),
      name: 'Guessed front',
      catalogProductId: String(polo._id),
      artworkTicketId: ticketId,
      decorationArea: 'front',
      placement: poloOptions.decorationAreas[1].defaultPlacement,
      variant: { sku: 'POLO-BLK-L' },
    },
  })).rejects.toThrow(/use one of: right, left, back/);

  const area = (key) => poloOptions.decorationAreas.find((row) => row.key === key);
  const leftPreview = await previewDesign({
    name: 'Polo left',
    productId: String(polo._id),
    ticketId,
    area: 'left',
    placement: area('left').defaultPlacement,
    variant: { sku: 'POLO-BLK-L', color: 'Black', size: 'L' },
  });
  const customPlacement = { centerXPercent: 28, centerYPercent: 50, widthPercent: 30, rotationDeg: 0 };
  const customPreview = await previewDesign({
    name: 'Polo left custom',
    productId: String(polo._id),
    ticketId,
    area: 'left',
    placement: customPlacement,
    variant: { sku: 'POLO-BLK-L' },
  });
  const rightPreview = await previewDesign({
    name: 'Polo right',
    productId: String(polo._id),
    ticketId,
    area: 'right',
    placement: area('right').defaultPlacement,
    variant: { sku: 'POLO-BLK-L' },
  });
  const backPreview = await previewDesign({
    name: 'Polo back',
    productId: String(polo._id),
    ticketId,
    area: 'back',
    placement: area('back').defaultPlacement,
    variant: { sku: 'POLO-BLK-L' },
  });
  const mugOptions = await getProductDesignOptions(String(mug._id));
  const mugPreview = await previewDesign({
    name: 'Mug wrap',
    productId: String(mug._id),
    ticketId,
    area: mugOptions.decorationAreas[0].key,
    placement: mugOptions.decorationAreas[0].defaultPlacement,
    variant: { sku: 'MUG-WHT' },
  });
  const teeOptions = await getProductDesignOptions(String(tee._id));
  const chest = teeOptions.decorationAreas.find((row) => row.key === 'front');
  const hem = teeOptions.decorationAreas.find((row) => row.key === 'front__1');
  const chestPreview = await previewDesign({
    name: 'Tee chest',
    productId: String(tee._id),
    ticketId,
    area: chest.key,
    placement: chest.defaultPlacement,
  });
  const hemPreview = await previewDesign({
    name: 'Tee hem',
    productId: String(tee._id),
    ticketId,
    area: hem.key,
    placement: hem.defaultPlacement,
  });

  const previews = [leftPreview, customPreview, rightPreview, backPreview, mugPreview, chestPreview, hemPreview];
  expect(previews.every((row) => row.preview.bakedMockup === true && row.preview.mockupUrl?.startsWith('/uploads/'))).toBe(true);
  expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);

  const decoded = {};
  for (const [name, row] of [
    ['left', leftPreview],
    ['custom', customPreview],
    ['right', rightPreview],
    ['back', backPreview],
    ['mug', mugPreview],
    ['chest', chestPreview],
    ['hem', hemPreview],
  ]) {
    const bytes = await readUpload(row.preview.mockupUrl);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(Buffer.compare(bytes, artwork)).not.toBe(0);
    const image = await decodePng(bytes);
    expect([image.width, image.height]).toEqual([1000, 1000]);
    decoded[name] = {
      red: inkBox(image, isRed),
      blue: inkBox(image, isBlue),
    };
  }

  expect(decoded.left.red.count).toBeGreaterThan(200);
  expect(decoded.right.red.count).toBeGreaterThan(200);
  expect(decoded.left.red.cx).toBeGreaterThan(decoded.right.red.cx + 80);
  expect(decoded.custom.red.w).toBeLessThan(decoded.left.red.w * 0.7);
  expect(decoded.custom.red.cx).toBeLessThan(decoded.left.red.cx - 15);
  expect(decoded.back.blue.count).toBeGreaterThan(decoded.left.blue.count + 1000);
  expect(decoded.back.red.count).toBeGreaterThan(decoded.left.red.count);
  expect(decoded.mug.red.count).toBeGreaterThan(200);
  expect(decoded.hem.red.cy).toBeGreaterThan(decoded.chest.red.cy + 40);
  expect(customPreview.preview.placement.printWPct).toBe(30);
  expect(leftPreview.preview.decorationArea).toEqual({ key: 'left', label: 'Left chest' });
  expect(hemPreview.preview.decorationArea).toEqual({ key: 'front__1', label: 'Hem' });

  const saved = await executeProductArtworkDesign({
    ...actor(),
    input: {
      shopId: String(shop._id),
      name: 'Polo left',
      catalogProductId: String(polo._id),
      artworkTicketId: ticketId,
      decorationArea: 'left',
      placement: area('left').defaultPlacement,
      variant: { sku: 'POLO-BLK-L', color: 'Black', size: 'L' },
    },
    confirmationId: leftPreview.confirmationId,
    idempotencyKey: 'polo-left-render-1',
  });
  expect(saved).toMatchObject({
    status: 'draft',
    published: false,
    bakedMockup: true,
    catalogProductId: String(polo._id),
  });
  const stored = await Collection.findOne({ _id: saved.id, tenantId: tenant._id });
  expect(stored.status).toBe('draft');
  expect(stored.shopId).toBeNull();
  expect(stored.shopIds).toEqual([]);
  expect(stored.productRefs[0].placements[0].key).toBe('left');
  expect(stored.productRefs[0].placements[0].artworkUrl).toBe(saved.artworkUrl);
  expect(stored.productRefs[0].selectedVariant).toMatchObject({
    sku: 'POLO-BLK-L', color: 'Black', size: 'L', colorHex: '#111111',
  });
  const savedMockup = await readUpload(stored.productRefs[0].mockupUrl);
  const savedDesign = await decodePng(savedMockup);
  expect(savedDesign.width).toBe(1000);
  expect(inkBox(savedDesign, isRed).count).toBeGreaterThan(200);
  const designOnly = await decodePng(await readUpload(stored.productRefs[0].designOnlyImageUrl));
  expect(designOnly.width).toBeGreaterThan(900);
  expect(designOnly.height).toBeGreaterThan(900);
  expect(inkBox(designOnly, isRed).count).toBeGreaterThan(200);
  expect((await Shop.findOne({ _id: shop._id, tenantId: tenant._id })).activeListingKeys).toEqual(['keep:listing']);
}, 240000);
