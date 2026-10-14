import { URL } from 'url';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '@/middleware/errorHandler';
import { Product } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import { PRODUCT_CATEGORIES } from '@/constants/categories.constant';
import { getAuthUserId } from '@/utils/request.utils';
import { indexProductImage } from '@/controllers/product.controller';

/**
 * Supermarket inventory: bulk upload (CSV rows parsed in the browser), a stock
 * table, and quick stock / price / On-Off / photo edits.
 *
 * Every route is for the signed-in shop owner only (buyers get 403), and only
 * ever touches products of the owner's own shop.
 */

const MAX_ROWS = 2000;
const MAX_STOCK_EDITS = 200;
const UPDATE_BATCH = 50;
const CREATE_BATCH = 500;

export interface InventoryRow {
  name?: unknown;
  price?: unknown;
  stock?: unknown;
  sku?: unknown;
  barcode?: unknown;
  unit?: unknown;
  category?: unknown;
  description?: unknown;
  image?: unknown;
}

type RowStatus = 'new' | 'update' | 'same' | 'error';

interface CheckedRow {
  row: number; // 1-based, as the owner sees it in their sheet (after the header)
  status: RowStatus;
  reason?: string;
  name: string;
  productId?: string;
  changes?: string[];
  data?: {
    name: string;
    price: number;
    stock: number;
    sku?: string;
    barcode?: string;
    unit?: string;
    category?: string;
    description?: string;
    image?: string;
  };
}

const text = (v: unknown, max: number): string =>
  v === undefined || v === null ? '' : String(v).trim().slice(0, max);

/** "₦1,200.50" / "1200" / 1200 → 1200.5; anything else → null. */
const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = text(v, 40)
    .replace(/[₦,\s]/g, '')
    .replace(/^NGN/i, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const categoryByLower = new Map(PRODUCT_CATEGORIES.map(c => [c.toLowerCase(), c]));

const isHttpsUrl = (s: string): boolean => {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The owner's shop, or a 403 sent (returns null). */
async function ownerBusiness(req: Request, res: Response) {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return null;
  }
  const business = await Business.findOne({ owner: userId }).select('_id');
  if (!business) {
    res.status(403).json({ success: false, message: 'Only shop owners can manage inventory.' });
    return null;
  }
  return { userId, businessId: business._id as Types.ObjectId };
}

/**
 * Check rows against the shop's current products. Saves nothing.
 * Matching: by SKU; without a SKU, by exact name. Never guesses: a name that
 * matches two products, or a SKU repeated in the file, is a problem row.
 */
export async function checkRows(businessId: Types.ObjectId, rawRows: InventoryRow[]) {
  const existing = await Product.find({ business: businessId })
    .select('_id name sku price stock category description unit barcode')
    .lean();

  const bySku = new Map<string, any>();
  const byName = new Map<string, any[]>();
  for (const p of existing as any[]) {
    if (p.sku) bySku.set(String(p.sku).toLowerCase(), p);
    const key = String(p.name).trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }

  // Count repeats inside the file first, so every copy is flagged.
  const skuCount = new Map<string, number>();
  const nameNoSkuCount = new Map<string, number>();
  for (const r of rawRows) {
    const sku = text(r?.sku, 64).toLowerCase();
    const name = text(r?.name, 120).toLowerCase();
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
    else if (name) nameNoSkuCount.set(name, (nameNoSkuCount.get(name) ?? 0) + 1);
  }

  const results: CheckedRow[] = rawRows.map((r, i) => {
    const row = i + 1;
    const name = text(r?.name, 120);
    const sku = text(r?.sku, 64);
    const fail = (reason: string): CheckedRow => ({
      row,
      status: 'error',
      reason: `Row ${row}: ${reason}`,
      name,
    });

    if (!name) return fail('Name is missing');

    const price = toNumber(r?.price);
    if (price === null) return fail('Price is missing or not a number');
    if (price < 0) return fail('Price cannot be negative');

    const stockRaw = text(r?.stock, 20);
    const stock = stockRaw === '' ? 0 : toNumber(stockRaw);
    if (stock === null || !Number.isInteger(stock) || stock < 0)
      return fail('Stock must be a whole number of 0 or more');

    if (sku && (skuCount.get(sku.toLowerCase()) ?? 0) > 1)
      return fail(`Item code "${sku}" appears more than once in the file`);
    if (!sku && (nameNoSkuCount.get(name.toLowerCase()) ?? 0) > 1)
      return fail(`"${name}" appears more than once with no item code. Add an item code to each`);

    const image = text(r?.image, 1000);
    if (image && !isHttpsUrl(image)) return fail('Image link must start with https://');

    const categoryIn = text(r?.category, 60);
    const category = categoryIn ? categoryByLower.get(categoryIn.toLowerCase()) : undefined;
    if (categoryIn && !category) return fail(`Unknown category "${categoryIn}"`);

    const data: NonNullable<CheckedRow['data']> = { name, price, stock };
    if (sku) data.sku = sku;
    const barcode = text(r?.barcode, 64);
    if (barcode) data.barcode = barcode;
    const unit = text(r?.unit, 30);
    if (unit) data.unit = unit;
    if (category) data.category = category;
    const description = text(r?.description, 2000);
    if (description) data.description = description;
    if (image) data.image = image;

    // Find the product this row is about.
    let match: any = sku ? bySku.get(sku.toLowerCase()) : undefined;
    if (!match) {
      const sameName = byName.get(name.toLowerCase()) ?? [];
      // Only fall back to the name for products that have no SKU yet, or when
      // the row itself has no SKU.
      const candidates = sku ? sameName.filter(p => !p.sku) : sameName;
      if (candidates.length > 1)
        return fail(
          `Your shop has ${candidates.length} products named "${name}". Add an item code`
        );
      match = candidates[0];
    }

    if (!match) return { row, status: 'new', name, data };

    const changes: string[] = [];
    if (match.price !== price) changes.push('price');
    if (match.stock !== stock) changes.push('stock');
    if (sku && match.sku !== sku) changes.push('sku');
    if (data.barcode && match.barcode !== data.barcode) changes.push('barcode');
    if (data.unit && match.unit !== data.unit) changes.push('unit');
    if (data.category && match.category !== data.category) changes.push('category');
    if (data.description && match.description !== data.description) changes.push('description');
    if (data.image) changes.push('photo');

    return {
      row,
      status: changes.length ? 'update' : 'same',
      name,
      productId: String(match._id),
      changes,
      data,
    };
  });

  const summary = { new: 0, update: 0, same: 0, error: 0 };
  for (const r of results) summary[r.status]++;
  return { results, summary };
}

const readRows = (req: Request, res: Response): InventoryRow[] | null => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ success: false, message: 'No rows to check.' });
    return null;
  }
  if (rows.length > MAX_ROWS) {
    res
      .status(400)
      .json({ success: false, message: `Up to ${MAX_ROWS} rows per upload. Split the file.` });
    return null;
  }
  return rows;
};

// GET /products/inventory — all the owner's products, including switched-off ones.
export const getInventory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const owner = await ownerBusiness(req, res);
  if (!owner) return;
  const products = await Product.find({ business: owner.businessId })
    .select('name sku barcode unit price stock category media isHidden description updatedAt')
    .sort({ name: 1 })
    .lean();
  res.json({ success: true, products });
});

// POST /products/bulk/preview { rows } — checks rows, saves nothing.
export const previewBulk = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const owner = await ownerBusiness(req, res);
  if (!owner) return;
  const rows = readRows(req, res);
  if (!rows) return;
  const { results, summary } = await checkRows(owner.businessId, rows);
  res.json({ success: true, summary, rows: results.map(({ data: _data, ...r }) => r) });
});

// POST /products/bulk/commit { rows } — re-checks on the server, saves good rows.
export const commitBulk = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const owner = await ownerBusiness(req, res);
  if (!owner) return;

  // Same rule as adding one product: the seller needs a payment profile.
  const user = await User.findById(owner.userId).select('paylukCustomerId');
  if (!user?.paylukCustomerId) {
    res.status(403).json({
      success: false,
      code: 'PAYLUK_SETUP_REQUIRED',
      message: 'Payment profile required to list products. Please complete your Payluk setup.',
    });
    return;
  }

  const rows = readRows(req, res);
  if (!rows) return;
  const { results, summary } = await checkRows(owner.businessId, rows);

  // Updates, in groups of 50. Only fields the row actually carries are changed.
  const updates = results.filter(r => r.status === 'update');
  for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
    const ops = updates.slice(i, i + UPDATE_BATCH).map(r => {
      const d = r.data!;
      const $set: Record<string, unknown> = { price: d.price, stock: d.stock };
      if (d.sku) $set.sku = d.sku;
      if (d.barcode) $set.barcode = d.barcode;
      if (d.unit) $set.unit = d.unit;
      if (d.category) $set.category = d.category;
      if (d.description) $set.description = d.description;
      const update: Record<string, unknown> = { $set };
      // A new photo becomes the main one; other photos are kept.
      if (d.image) update.$push = { media: { $each: [d.image], $position: 0 } };
      return {
        updateOne: {
          filter: { _id: new Types.ObjectId(r.productId!), business: owner.businessId },
          update,
        },
      };
    });
    await Product.bulkWrite(ops as any, { ordered: false });
  }

  // Creates, in groups of 500. Bulk saves skip Payluk's template escrow — it is
  // not used for buyer checkout (each order creates its own escrow).
  const creates = results.filter(r => r.status === 'new');
  const toIndex: { id: string; image: string }[] = [];
  for (let i = 0; i < creates.length; i += CREATE_BATCH) {
    const docs = creates.slice(i, i + CREATE_BATCH).map(r => {
      const d = r.data!;
      return {
        business: owner.businessId,
        name: d.name,
        price: d.price,
        stock: d.stock,
        category: d.category || 'General',
        description: d.description || '',
        media: d.image ? [d.image] : [],
        ...(d.sku ? { sku: d.sku } : {}),
        ...(d.barcode ? { barcode: d.barcode } : {}),
        ...(d.unit ? { unit: d.unit } : {}),
      };
    });
    const inserted = await Product.insertMany(docs, { ordered: false });
    for (const p of inserted as any[]) {
      if (p.media?.[0]) toIndex.push({ id: String(p._id), image: p.media[0] });
    }
  }
  for (const r of updates) {
    if (r.data?.image) toIndex.push({ id: r.productId!, image: r.data.image });
  }

  // Index photos for image search in the background, one at a time.
  void (async () => {
    for (const p of toIndex) await indexProductImage(p.id, p.image);
  })();

  res.json({
    success: true,
    summary,
    saved: { created: creates.length, updated: updates.length },
    problems: results.filter(r => r.status === 'error').map(r => r.reason),
  });
});

// PATCH /products/stock { items: [{ id, stock?, price?, isHidden?, photoUrl? }] }
export const updateStock = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const owner = await ownerBusiness(req, res);
  if (!owner) return;

  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, message: 'Nothing to save.' });
    return;
  }
  if (items.length > MAX_STOCK_EDITS) {
    res
      .status(400)
      .json({ success: false, message: `Up to ${MAX_STOCK_EDITS} changes at a time.` });
    return;
  }

  const ops: any[] = [];
  const newPhotos: { id: string; url: string }[] = [];
  for (const [i, item] of items.entries()) {
    const bad = (msg: string) => {
      res.status(400).json({ success: false, message: `Change ${i + 1}: ${msg}` });
    };
    if (!item || !Types.ObjectId.isValid(String(item.id))) return bad('unknown product');

    const $set: Record<string, unknown> = {};
    if (item.stock !== undefined) {
      if (!Number.isInteger(item.stock) || item.stock < 0)
        return bad('stock must be a whole number of 0 or more');
      $set.stock = item.stock;
    }
    if (item.price !== undefined) {
      if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0)
        return bad('price must be 0 or more');
      $set.price = item.price;
    }
    if (item.isHidden !== undefined) {
      if (typeof item.isHidden !== 'boolean') return bad('On/Off must be true or false');
      $set.isHidden = item.isHidden;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (item.photoUrl !== undefined) {
      if (typeof item.photoUrl !== 'string' || !isHttpsUrl(item.photoUrl))
        return bad('photo must be an https link');
      update.$push = { media: { $each: [item.photoUrl], $position: 0 } };
      newPhotos.push({ id: String(item.id), url: item.photoUrl });
    }
    if (!Object.keys(update).length) continue;

    ops.push({
      updateOne: {
        // business filter: only the owner's own products can change.
        filter: { _id: new Types.ObjectId(String(item.id)), business: owner.businessId },
        update,
      },
    });
  }

  const result = ops.length ? await Product.bulkWrite(ops, { ordered: false }) : null;
  const matched = result?.matchedCount ?? 0;

  for (const p of newPhotos) indexProductImage(p.id, p.url).catch(() => {});

  res.json({
    success: true,
    updated: matched,
    // Ids that weren't the owner's (or don't exist) are simply not changed.
    skipped: ops.length - matched,
  });
});
