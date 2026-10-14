/**
 * Stock hold at checkout.
 * ------------------------
 * When a buyer starts paying, the items are taken off the shelf right away (an
 * atomic "only if enough is left" decrement), so two buyers can't both pay for
 * the last one. If the order isn't paid within STOCK_HOLD_MINUTES, the sweep
 * puts the stock back. A payment that still arrives later is honoured as before
 * (stock is then taken, floored at zero, and the seller is warned).
 */
import Order from '@/models/order-model';
import { Product } from '@/models/product-model';

const HOLD_MINUTES = Math.max(5, Number(process.env.STOCK_HOLD_MINUTES) || 30);
const SWEEP_INTERVAL_MS = 2 * 60_000;
const SWEEP_BATCH = 100;

export interface HoldItem {
  product: unknown;
  name: string;
  quantity: number;
}

export const holdExpiry = (): Date => new Date(Date.now() + HOLD_MINUTES * 60_000);

/** Put stock back for items that were held. */
export async function releaseItems(items: HoldItem[]): Promise<void> {
  for (const item of items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
  }
}

/**
 * Take stock for every item, or none: if one item has run out, the ones
 * already taken are put back and a 400 is thrown naming the item.
 */
export async function holdItems(items: HoldItem[]): Promise<void> {
  const taken: HoldItem[] = [];
  for (const item of items) {
    const res = await Product.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } }
    );
    if (res.modifiedCount === 0) {
      await releaseItems(taken);
      const left = await Product.findById(item.product).select('stock').lean();
      const err: any = new Error(
        `"${item.name}" only has ${Math.max(0, (left as any)?.stock ?? 0)} unit(s) left in stock`
      );
      err.status = 400;
      throw err;
    }
    taken.push(item);
  }
}

/**
 * Release the hold on unpaid orders matching `filter`. The flag is cleared in
 * the same atomic update that checks the order is still unpaid, so a payment
 * and a release can never both count the same stock.
 */
export async function releaseUnpaidHolds(filter: Record<string, unknown>): Promise<number> {
  const candidates = await Order.find({ ...filter, paymentStatus: 'pending', stockReserved: true })
    .select('_id')
    .limit(SWEEP_BATCH)
    .lean();
  let released = 0;
  for (const c of candidates) {
    const order = await Order.findOneAndUpdate(
      { _id: c._id, paymentStatus: 'pending', stockReserved: true },
      { $set: { stockReserved: false } }
    );
    if (!order) continue; // paid or released in the meantime
    await releaseItems(order.items);
    released++;
  }
  return released;
}

let running = false;
async function sweepOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const n = await releaseUnpaidHolds({ reservedUntil: { $lt: new Date() } });
    if (n) console.log(`📦 [stock-hold] released stock for ${n} unpaid order(s)`);
  } catch (err) {
    console.error('[stock-hold] sweep failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/** Start the periodic release of expired holds. Call once on server boot. */
export function startStockHoldSweep(): void {
  setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  console.log(`[stock-hold] unpaid orders hold stock for ${HOLD_MINUTES} min.`);
}
