import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { connectTestDb, clearTestDb, disconnectTestDb } from './setup.js';
import { createApp } from '../src/app.js';
import { CatalogProduct } from '../src/modules/catalog/catalogProduct.model.js';
import { Collection } from '../src/modules/collections/collection.model.js';
import { Shop } from '../src/modules/shops/shop.model.js';
import { McpShopAssetTicket } from '../src/modules/mcp/mcpShopAssetTicket.model.js';
import { completeShopAssetUpload, prepareShopAssetUpload } from '../src/modules/mcp/shopsAssetUpload.js';
import {
  executeProductArtworkDesign,
  getProductArtworkUpload,
  prepareProductArtworkDesign,
  prepareProductArtworkUpload,
} from '../src/modules/mcp/productArtworkWrite.js';
import { getProductDesignOptions } from '../src/modules/mcp/productDesignOptions.js';
import * as swagRenderer from '../src/modules/copilot/swagRenderer.service.js';
import { COPILOT_MCP_TOOL_NAMES } from '../src/modules/copilot/copilotMcpCatalog.js';
import { clearTenantLimitCache } from '../src/services/tenantGuardrails.service.js';
import { makeTenant, makeUser } from './helpers.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let app;
let tenant;
let admin;
let manager;
let otherTenant;
let otherAdmin;
let shop;
let otherShop;
let product;

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([t, data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}

function makePng(pixelsPerMetre = 11811) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(pixelsPerMetre, 0);
  phys.writeUInt32BE(pixelsPerMetre, 4);
  phys[8] = 1;
  const idat = deflateSync(Buffer.from([0, 0, 0, 0]));
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('pHYs', phys),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ARTWORK_PNG = makePng();

function actorOf(user) {
  return { tenantId: user.tenantId, actorUserId: user.user._id };
}

function designInput(extra = {}) {
  return {
    shopId: String(shop._id),
    name: 'Navy mug mark',
    catalogProductId: String(product._id),
    artworkTicketId: extra.artworkTicketId || 'ticket-placeholder',
    decorationArea: 'Front',
    placement: { centerXPercent: 50, centerYPercent: 40, widthPercent: 30, rotationDeg: 0 },
    variant: { sku: 'MUG-NAVY-M', color: 'Navy', size: 'M' },
    ...extra,
  };
}

async function uploadArtwork({ owner = admin, workspace = tenant, png = ARTWORK_PNG, name = 'mark.png' } = {}) {
  const prepared = await prepareProductArtworkUpload({
    ...actorOf({ ...owner, tenantId: workspace._id }),
    input: { originalName: name },
  });
  const completed = await completeShopAssetUpload({
    ticketId: prepared.ticketId,
    uploadToken: prepared.uploadToken,
    file: { buffer: png, originalname: name, mimetype: 'image/png' },
  });
  return { prepared, completed };
}

beforeAll(async () => {
  await connectTestDb();
  app = createApp();
});

afterAll(disconnectTestDb);

beforeEach(async () => {
  await clearTestDb();
  clearTenantLimitCache();
  tenant = await makeTenant({ slug: 'artwork-a' });
  otherTenant = await makeTenant({ slug: 'artwork-b' });
  admin = await makeUser(tenant, 'company_admin', 'tenant');
  manager = await makeUser(tenant, 'entity_manager', 'tenant');
  otherAdmin = await makeUser(otherTenant, 'company_admin', 'tenant');
  shop = await Shop.create({
    tenantId: tenant._id,
    name: 'HQ Store',
    slug: `hq-art-${Date.now()}`,
    status: 'live',
    activeListingKeys: ['keep:listing'],
  });
  otherShop = await Shop.create({
    tenantId: otherTenant._id,
    name: 'Other Store',
    slug: `other-art-${Date.now()}`,
    status: 'live',
    activeListingKeys: ['keep:other'],
  });
  product = await CatalogProduct.create({
    sku: `SM-ART-${Date.now()}`,
    name: 'Desk Mug',
    category: 'Drinkware',
    group: 'mug',
    basePriceInr: 400,
    baseImageUrl: 'https://cdn.test/mug-base.png',
    printAreas: [{ key: 'front', label: 'Front', widthIn: 3, heightIn: 3 }],
    variants: [
      { sku: 'MUG-NAVY-M', color: 'Navy', size: 'M', enabled: true },
      { sku: 'MUG-NAVY-S', color: 'Navy', size: 'S', enabled: false },
    ],
  });
});

describe('product artwork MCP', () => {
  it('keeps the new ChatGPT tools off the embedded copilot catalog', () => {
    for (const name of [
      'products_prepare_artwork_upload',
      'products_get_artwork_upload',
      'products_prepare_design',
      'products_execute_design',
      'products_get_design_options',
    ]) {
      expect(COPILOT_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it('rejects a non-admin and does not create an upload ticket', async () => {
    await expect(prepareProductArtworkUpload({
      ...actorOf({ ...manager, tenantId: tenant._id }),
      input: {},
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...manager, tenantId: tenant._id }),
      input: designInput({ artworkTicketId: '0123456789abcdef' }),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await McpShopAssetTicket.countDocuments({ tenantId: tenant._id })).toBe(0);
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);
  });

  it('issues a browser upload link and refuses to start product artwork from the store logo tool', async () => {
    const prepared = await prepareProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { originalName: 'mark.png' },
    });
    expect(prepared.kind).toBe('product_artwork');
    expect(prepared.uploadPageUrl).toContain(`#uploadToken=${encodeURIComponent(prepared.uploadToken)}`);
    expect(prepared.uploadPageUrl.split('#')[0]).not.toContain('uploadToken');
    expect(prepared.instructions).toContain('ChatGPT cannot forward');
    expect(prepared.assetUrl).toBeUndefined();

    const page = await request(app).get(`/api/v1/mcp/shop-assets/${prepared.ticketId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Upload product artwork');
    expect(page.text).toContain('Product artwork PNG');
    expect(page.text).toContain('accept=".png,image/png"');
    expect(page.text).not.toContain(prepared.uploadToken);

    await completeShopAssetUpload({
      ticketId: prepared.ticketId,
      uploadToken: prepared.uploadToken,
      file: { buffer: ARTWORK_PNG, originalname: 'mark.png', mimetype: 'image/png' },
    });
    const done = await request(app).get(`/api/v1/mcp/shop-assets/${prepared.ticketId}`);
    expect(done.status).toBe(200);
    expect(done.text).toContain('products_prepare_design');
    expect(done.text).toContain('not saved until you confirm');

    await expect(prepareShopAssetUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { kind: 'product_artwork' },
    })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a non-PNG and a low-DPI PNG without storing an asset', async () => {
    const badType = await prepareProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: {},
    });
    await expect(completeShopAssetUpload({
      ticketId: badType.ticketId,
      uploadToken: badType.uploadToken,
      file: { buffer: Buffer.from('not-a-png'), originalname: 'logo.jpg', mimetype: 'image/jpeg' },
    })).rejects.toMatchObject({ code: 'INVALID_ARTWORK' });

    const lowDpi = await prepareProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: {},
    });
    await expect(completeShopAssetUpload({
      ticketId: lowDpi.ticketId,
      uploadToken: lowDpi.uploadToken,
      file: { buffer: makePng(2835), originalname: 'soft.png', mimetype: 'image/png' },
    })).rejects.toMatchObject({ code: 'INVALID_ARTWORK' });

    const damaged = await prepareProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: {},
    });
    await expect(completeShopAssetUpload({
      ticketId: damaged.ticketId,
      uploadToken: damaged.uploadToken,
      file: { buffer: Buffer.from('not-a-png'), originalname: 'mark.png', mimetype: 'image/png' },
    })).rejects.toMatchObject({ code: 'INVALID_ARTWORK' });

    const tickets = await McpShopAssetTicket.find({ tenantId: tenant._id });
    expect(tickets).toHaveLength(3);
    for (const ticket of tickets) {
      expect(ticket.status).toBe('pending');
      expect(ticket.assetUrl || '').toBe('');
    }
  });

  it('hides another tenant ticket and store', async () => {
    const { prepared } = await uploadArtwork();
    await expect(getProductArtworkUpload({
      tenantId: otherTenant._id,
      actorUserId: otherAdmin.user._id,
      ticketId: prepared.ticketId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(prepareProductArtworkDesign({
      tenantId: otherTenant._id,
      actorUserId: otherAdmin.user._id,
      input: designInput({
        shopId: String(otherShop._id),
        artworkTicketId: prepared.ticketId,
      }),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: designInput({
        shopId: String(otherShop._id),
        artworkTicketId: prepared.ticketId,
      }),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);
    expect(await Collection.countDocuments({ tenantId: otherTenant._id })).toBe(0);
  });

  it('rejects an unready upload, a logo ticket, a bad area, a bad variant, a bad placement, and an arbitrary URL', async () => {
    const pending = await prepareProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: {},
    });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: designInput({ artworkTicketId: pending.ticketId }),
    })).rejects.toMatchObject({ code: 'ASSET_REQUIRED' });

    const logo = await prepareShopAssetUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { kind: 'logo' },
    });
    await completeShopAssetUpload({
      ticketId: logo.ticketId,
      uploadToken: logo.uploadToken,
      file: { buffer: ARTWORK_PNG, originalname: 'logo.png', mimetype: 'image/png' },
    });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: designInput({ artworkTicketId: logo.ticketId }),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const { prepared } = await uploadArtwork();
    const base = designInput({ artworkTicketId: prepared.ticketId });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, decorationArea: 'Sleeve' },
    })).rejects.toMatchObject({ code: 'DECORATION_AREA_INVALID' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, variant: { sku: 'MUG-NAVY-S' } },
    })).rejects.toMatchObject({ code: 'VARIANT_INVALID' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, variant: { sku: 'NO-SUCH' } },
    })).rejects.toMatchObject({ code: 'VARIANT_INVALID' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, placement: { centerXPercent: 5, centerYPercent: 50, widthPercent: 20 } },
    })).rejects.toMatchObject({ code: 'PLACEMENT_INVALID' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, placement: { centerXPercent: 50, centerYPercent: 50, widthPercent: 80, rotationDeg: 45 } },
    })).rejects.toMatchObject({ code: 'PLACEMENT_INVALID' });
    await expect(prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...base, artworkUrl: 'https://evil.example/art.png' },
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);
  });

  it('previews without saving, rejects a bad confirmation, and persists one unpublished draft', async () => {
    const { prepared, completed } = await uploadArtwork();
    const input = designInput({ artworkTicketId: prepared.ticketId });
    const preview = await prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
    });
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);
    expect(preview.preview).toMatchObject({
      action: 'create',
      status: 'draft',
      published: false,
      bakedMockup: false,
      artworkUrl: completed.assetUrl,
      productImageUrl: 'https://cdn.test/mug-base.png',
      decorationArea: { key: 'front', label: 'Front' },
      placement: { printCxPct: 50, printCyPct: 40, printWPct: 30, rot: 0 },
      variant: { sku: 'MUG-NAVY-M', color: 'Navy', size: 'M' },
    });
    expect(preview.preview.artworkUrl).toMatch(/^\/uploads\//);
    expect(preview.confirmationId).toBeTruthy();

    await expect(executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
      confirmationId: 'not-a-real-confirmation-token',
      idempotencyKey: 'art-missing-confirm',
    })).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });

    await expect(executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...input, placement: { ...input.placement, widthPercent: 20 } },
      confirmationId: preview.confirmationId,
      idempotencyKey: 'art-mismatch',
    })).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);

    product.printAreas[0].key = 'chest';
    await product.save();
    await expect(executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
      confirmationId: preview.confirmationId,
      idempotencyKey: 'art-stale',
    })).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' });
    product.printAreas[0].key = 'front';
    await product.save();

    const fresh = await prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
    });
    const saved = await executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
      confirmationId: fresh.confirmationId,
      idempotencyKey: 'art-save-1',
    });
    expect(saved).toMatchObject({
      name: 'Navy mug mark',
      status: 'draft',
      published: false,
      bakedMockup: false,
      artworkUrl: completed.assetUrl,
      shopId: String(shop._id),
      catalogProductId: String(product._id),
    });
    expect(saved.mockupUrl).toBeUndefined();

    const stored = await Collection.findOne({ _id: saved.id, tenantId: tenant._id });
    expect(stored.status).toBe('draft');
    expect(stored.shopId).toBeFalsy();
    expect(stored.shopIds).toEqual([]);
    expect(stored.artworkUrl).toBe(completed.assetUrl);
    expect(stored.preferredColors).toEqual(['Navy']);
    expect(stored.productRefs).toHaveLength(1);
    expect(stored.productRefs[0].mockupUrl || '').toBe('');
    expect(stored.productRefs[0].inheritArtwork).toBe(false);
    expect(stored.productRefs[0].placement).toMatchObject({
      printCxPct: 50, printCyPct: 40, printWPct: 30, rot: 0,
    });
    expect(stored.productRefs[0].placements[0]).toMatchObject({
      key: 'front',
      artworkUrl: completed.assetUrl,
      printWPct: 30,
    });
    expect(stored.productRefs[0].selectedVariant).toMatchObject({
      sku: 'MUG-NAVY-M',
      color: 'Navy',
      size: 'M',
    });

    const onDisk = await fs.readFile(path.join(apiRoot, completed.assetUrl.replace(/^\//, '')));
    expect(Buffer.compare(onDisk, ARTWORK_PNG)).toBe(0);

    const liveShop = await Shop.findOne({ _id: shop._id, tenantId: tenant._id });
    expect(liveShop.activeListingKeys).toEqual(['keep:listing']);
    const foreignShop = await Shop.findOne({ _id: otherShop._id, tenantId: otherTenant._id });
    expect(foreignShop.activeListingKeys).toEqual(['keep:other']);

    const again = await executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input,
      confirmationId: fresh.confirmationId,
      idempotencyKey: 'art-save-1',
    });
    expect(again.id).toBe(saved.id);
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(1);

    const ticket = await getProductArtworkUpload({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      ticketId: prepared.ticketId,
    });
    expect(ticket.status).toBe('consumed');
    expect(ticket.assetUrl).toBe(completed.assetUrl);

    const moved = await prepareProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...input, placement: { ...input.placement, widthPercent: 20 } },
    });
    await expect(executeProductArtworkDesign({
      ...actorOf({ ...admin, tenantId: tenant._id }),
      input: { ...input, placement: { ...input.placement, widthPercent: 20 } },
      confirmationId: moved.confirmationId,
      idempotencyKey: 'art-save-2',
    })).rejects.toMatchObject({ code: 'COLLECTION_EXISTS' });
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(1);
  });

  it('uses ActiveDry Polo decoration keys and keeps another product on its own area', async () => {
    const polo = await CatalogProduct.create({
      sku: `POLO-${Date.now()}`,
      name: 'ActiveDry Polo',
      category: 'Apparel',
      group: 'polo',
      basePriceInr: 840,
      primaryImageUrl: 'https://cdn.test/polo.png',
      physicalDimensions: { width: 20, height: 26, length: 18 },
      printAreas: [
        { key: 'right', label: 'Right', xIn: 2, yIn: 4, widthIn: 3.5, heightIn: 3.5 },
        { key: 'left', label: 'Left', xIn: 14, yIn: 4, widthIn: 3.5, heightIn: 3.5 },
        { key: 'back', label: 'Back', xIn: 6, yIn: 5, widthIn: 8, heightIn: 10 },
      ],
      variants: [{ sku: 'POLO-BLK-L', color: 'Black', colorHex: '#111111', size: 'L', enabled: true }],
    });
    const mug = await CatalogProduct.create({
      sku: `WRAP-${Date.now()}`,
      name: 'Camp Mug',
      category: 'Drinkware',
      group: 'mug',
      basePriceInr: 300,
      primaryImageUrl: 'https://cdn.test/mug.png',
      physicalDimensions: { width: 12, height: 10, length: 12 },
      printAreas: [{ key: 'wrap', label: 'Wrap', xIn: 1, yIn: 2, widthIn: 8, heightIn: 3 }],
      variants: [{ sku: 'MUG-WHT', color: 'White', colorHex: '#ffffff', size: 'OS', enabled: true }],
    });
    const split = await CatalogProduct.create({
      sku: `TEE-${Date.now()}`,
      name: 'Split Tee',
      category: 'Apparel',
      group: 'tee',
      basePriceInr: 500,
      primaryImageUrl: 'https://cdn.test/tee.png',
      physicalDimensions: { width: 20, height: 24, length: 18 },
      printAreas: [
        { key: 'front', label: 'Chest', xIn: 7, yIn: 6, widthIn: 4, heightIn: 4 },
        { key: 'front', label: 'Hem', xIn: 7, yIn: 16, widthIn: 4, heightIn: 2 },
      ],
    });

    const poloOptions = await getProductDesignOptions(String(polo._id));
    expect(poloOptions.decorationAreas.map((area) => area.key)).toEqual(['right', 'left', 'back']);
    expect(poloOptions.defaultDecorationArea).toBe('left');
    expect(poloOptions.decorationAreas.find((area) => area.key === 'left')).toMatchObject({
      label: 'Left',
      view: 'left',
      isDefault: true,
      rendererCompatible: true,
      imageUrl: 'https://cdn.test/polo.png',
      widthIn: 3.5,
      heightIn: 3.5,
    });
    expect(poloOptions.images).toContain('https://cdn.test/polo.png');
    expect(poloOptions.variants).toEqual([
      { sku: 'POLO-BLK-L', color: 'Black', colorHex: '#111111', size: 'L' },
    ]);
    expect(poloOptions.decorationAreas.every((area) => area.rendererCompatible === true)).toBe(true);

    const mugOptions = await getProductDesignOptions(String(mug._id));
    expect(mugOptions.decorationAreas.map((area) => area.key)).toEqual(['wrap']);
    expect(mugOptions.defaultDecorationArea).toBe('wrap');

    const splitOptions = await getProductDesignOptions(String(split._id));
    expect(splitOptions.decorationAreas.map((area) => area.key)).toEqual(['front', 'front__1']);
    expect(splitOptions.decorationAreas.map((area) => area.label)).toEqual(['Chest', 'Hem']);

    const { prepared } = await uploadArtwork();
    const actor = actorOf({ ...admin, tenantId: tenant._id });
    await expect(prepareProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Polo mark',
        catalogProductId: String(polo._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: 'front',
        variant: { sku: 'POLO-BLK-L' },
      }),
    })).rejects.toThrow(/use one of: right, left, back/);

    const left = poloOptions.decorationAreas.find((area) => area.key === 'left');
    const preview = await prepareProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Polo mark',
        catalogProductId: String(polo._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: poloOptions.defaultDecorationArea,
        placement: left.defaultPlacement,
        variant: { sku: 'POLO-BLK-L', color: 'Black', size: 'L' },
      }),
    });
    expect(preview.preview).toMatchObject({
      bakedMockup: false,
      decorationArea: { key: 'left', label: 'Left' },
      variant: { sku: 'POLO-BLK-L', color: 'Black', size: 'L' },
    });
    expect(preview.preview.mockupUrl).toBeUndefined();
    expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);

    const saved = await executeProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Polo mark',
        catalogProductId: String(polo._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: 'left',
        placement: left.defaultPlacement,
        variant: { sku: 'POLO-BLK-L', color: 'Black', size: 'L' },
      }),
      confirmationId: preview.confirmationId,
      idempotencyKey: 'polo-left-1',
    });
    expect(saved).toMatchObject({
      status: 'draft',
      published: false,
      bakedMockup: false,
      catalogProductId: String(polo._id),
      artworkUrl: preview.preview.artworkUrl,
    });
    const stored = await Collection.findOne({ _id: saved.id, tenantId: tenant._id });
    expect(stored.productRefs[0].placements[0].key).toBe('left');
    expect(stored.productRefs[0].placements[0].artworkUrl).toBe(preview.preview.artworkUrl);
    expect(stored.productRefs[0].selectedVariant).toMatchObject({
      sku: 'POLO-BLK-L', color: 'Black', size: 'L', colorHex: '#111111',
    });
    expect(stored.productRefs[0].mockupUrl || '').toBe('');
    expect(stored.status).toBe('draft');
    expect((await Shop.findOne({ _id: shop._id, tenantId: tenant._id })).activeListingKeys).toEqual(['keep:listing']);

    await expect(prepareProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Mug wrap',
        catalogProductId: String(mug._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: 'front',
        variant: { sku: 'MUG-WHT' },
      }),
    })).rejects.toThrow(/use one of: wrap/);

    const wrap = mugOptions.decorationAreas[0];
    const mugPreview = await prepareProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Mug wrap',
        catalogProductId: String(mug._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: wrap.key,
        placement: wrap.defaultPlacement,
        variant: { sku: 'MUG-WHT', color: 'White', size: 'OS' },
      }),
    });
    const mugSaved = await executeProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Mug wrap',
        catalogProductId: String(mug._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: wrap.key,
        placement: wrap.defaultPlacement,
        variant: { sku: 'MUG-WHT', color: 'White', size: 'OS' },
      }),
      confirmationId: mugPreview.confirmationId,
      idempotencyKey: 'mug-wrap-1',
    });
    const mugStored = await Collection.findOne({ _id: mugSaved.id, tenantId: tenant._id });
    expect(mugStored.productRefs[0].placements[0].key).toBe('wrap');
    expect(mugStored.productRefs[0].selectedVariant.sku).toBe('MUG-WHT');

    const hem = splitOptions.decorationAreas.find((area) => area.key === 'front__1');
    const hemPreview = await prepareProductArtworkDesign({
      ...actor,
      input: designInput({
        name: 'Tee hem',
        catalogProductId: String(split._id),
        artworkTicketId: prepared.ticketId,
        decorationArea: hem.key,
        placement: hem.defaultPlacement,
        variant: undefined,
      }),
    });
    expect(hemPreview.preview.decorationArea).toEqual({ key: 'front__1', label: 'Hem' });
    expect(hemPreview.preview.bakedMockup).toBe(false);
  });

  it('stores a renderer image only when the renderer returns a real PNG', async () => {
    const { prepared, completed } = await uploadArtwork();
    product.baseImageUrl = completed.assetUrl;
    product.maskImageUrl = completed.assetUrl;
    product.printAreas = [{
      key: 'front',
      label: 'Front',
      xIn: 7,
      yIn: 6,
      widthIn: 6,
      heightIn: 6,
      dpi: 300,
      methods: ['dtf'],
    }];
    product.physicalDimensions = { width: 20, height: 24, length: 18 };
    await product.save();

    const options = await getProductDesignOptions(String(product._id));
    const front = options.decorationAreas.find((area) => area.key === 'front');
    expect(front.rendererCompatible).toBe(true);
    const actor = actorOf({ ...admin, tenantId: tenant._id });
    const input = designInput({
      name: 'Baked front',
      artworkTicketId: prepared.ticketId,
      decorationArea: front.key,
      placement: front.defaultPlacement,
    });

    const configured = vi.spyOn(swagRenderer, 'rendererConfigured').mockReturnValue(true);
    const requests = [];
    const render = vi.spyOn(swagRenderer, 'withSwagRenderer').mockImplementation(async (run) => run({
      version: 'test-renderer',
      evaluate: async (_op, args) => {
        requests.push(args[3]);
        return { dataUrl: `data:image/png;base64,${ARTWORK_PNG.toString('base64')}` };
      },
    }));
    try {
      const preview = await prepareProductArtworkDesign({ ...actor, input });
      expect(requests.at(-1)).toMatchObject({
        areaKey: 'front',
        placement: { printWPct: front.defaultPlacement.widthPercent },
      });
      expect(preview.preview.bakedMockup).toBe(true);
      expect(preview.preview.mockupUrl).toMatch(/^\/uploads\//);
      const previewBytes = await fs.readFile(path.join(apiRoot, preview.preview.mockupUrl.replace(/^\//, '')));
      expect(Buffer.compare(previewBytes, ARTWORK_PNG)).toBe(0);
      expect(await Collection.countDocuments({ tenantId: tenant._id })).toBe(0);

      const saved = await executeProductArtworkDesign({
        ...actor,
        input,
        confirmationId: preview.confirmationId,
        idempotencyKey: 'baked-front-1',
      });
      expect(saved.bakedMockup).toBe(true);
      const stored = await Collection.findOne({ _id: saved.id, tenantId: tenant._id });
      expect(stored.productRefs[0].mockupUrl).toBe(saved.mockupUrl);
      expect(stored.productRefs[0].placements[0].key).toBe('front');
      const savedBytes = await fs.readFile(path.join(apiRoot, stored.productRefs[0].mockupUrl.replace(/^\//, '')));
      expect(Buffer.compare(savedBytes, ARTWORK_PNG)).toBe(0);

      requests.length = 0;
      const moved = await prepareProductArtworkDesign({
        ...actor,
        input: { ...input, name: 'Moved front', placement: { ...front.defaultPlacement, widthPercent: 40 } },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].areaKey).toBe('front');
      expect(requests[0].placement.printWPct).toBe(40);
      expect(moved.preview.bakedMockup).toBe(true);
      expect(moved.preview.mockupUrl).toMatch(/^\/uploads\//);

      render.mockRejectedValue(new Error('renderer down'));
      const failed = await prepareProductArtworkDesign({
        ...actor,
        input: { ...input, name: 'Renderer down' },
      });
      expect(failed.preview.bakedMockup).toBe(false);
      expect(failed.preview.mockupUrl).toBeUndefined();
    } finally {
      configured.mockRestore();
      render.mockRestore();
    }
  });
});
