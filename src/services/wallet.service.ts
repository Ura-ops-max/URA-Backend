/**
 * The signed-in user's Payluk wallet, through URA's backend. Always the user's
 * OWN Payluk customer id. Short caches save Payluk's 10-requests-a-minute
 * budget (shared by every user) for payments.
 */
import Order from '@/models/order-model';
import { Business } from '@/models/business-model';
import {
  createWithdrawalIntent,
  executePaymentIntent,
  getBankList,
  getPaymentHistory,
  getWallet,
  verifyBankAccount,
} from '@/services/payluk.service';

/**
 * Payluk sometimes reports the currency as "NG" (a country code). Browsers
 * throw on that when formatting money, which crashed the wallet page.
 * Always send a valid 3-letter currency code.
 */
export const normalizeCurrency = (c: unknown): string => {
  const v = String(c ?? '')
    .trim()
    .toUpperCase();
  if (v === 'NG' || v === 'NAIRA' || v === '₦') return 'NGN';
  return /^[A-Z]{3}$/.test(v) ? v : 'NGN';
};

// ─── Tiny TTL cache ──────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; value: unknown }>();
const WALLET_TTL = 30_000;
const LIST_TTL = 30_000;
const BANKS_TTL = 24 * 60 * 60_000;

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Forget a customer's cached wallet data (after they pay or withdraw). */
export function invalidateWalletCache(customerId: string): void {
  for (const key of cache.keys()) if (key.includes(`:${customerId}:`)) cache.delete(key);
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export const walletBalance = async (customerId: string) => {
  const w = await cached(`wallet:${customerId}:`, WALLET_TTL, () => getWallet(customerId));
  return { ...w, currency: normalizeCurrency(w.currency) };
};

// ─── Activity: money rows with names (Part 1) ────────────────────────────────

/** "Amaka O." from a first and last name. Never the full surname in lists. */
export const shortName = (first?: string | null, last?: string | null): string => {
  const f = String(first ?? '').trim();
  const l = String(last ?? '').trim();
  return [f, l ? `${l[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') || 'A customer';
};

export type ActivityType = 'Payment received' | 'Payment sent' | 'Withdrawal' | 'Refund';
export type ActivityStatus = 'Success' | 'Pending' | 'Failed' | 'Held' | 'Released';

export interface ActivityRow {
  id: string;
  type: ActivityType;
  direction: 'credit' | 'debit';
  /** "From Amaka O. · ORD-..." / "To <shop> · ORD-..." / "Payment". */
  details: string;
  amount: number;
  fee: number;
  currency: string;
  status: ActivityStatus;
  date: string | null;
  /** The URA order to open, when this row belongs to one of the user's orders. */
  orderId: string | null;
}

// Our checkout references start with the order id (orderId, orderId-2,
// orderId-wallet-1), so a row can be matched to its order from them.
const orderIdFromReference = (ref: unknown): string | null => {
  const m = /^([0-9a-f]{24})(?:-|$)/i.exec(String(ref ?? ''));
  return m ? m[1] : null;
};

const baseStatus = (s: unknown): ActivityStatus =>
  String(s).toLowerCase() === 'failed' || String(s).toLowerCase() === 'reversed'
    ? 'Failed'
    : String(s).toLowerCase() === 'pending'
      ? 'Pending'
      : 'Success';

/**
 * The signed-in user's own money rows, with names from URA's orders. Only
 * orders the user bought, or sold through a shop they own, are used, so one
 * user can never see another user's names. No references, emails, phones or
 * Payluk ids are returned.
 */
export async function walletActivity(userId: string, customerId: string, page = 1, limit = 20) {
  const d: any = await cached(`history:${customerId}:${page}:${limit}:`, LIST_TTL, () =>
    getPaymentHistory({ customerId, page, limit })
  );
  const rows: any[] = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];

  const tokens = rows.map(r => r?.escrowDetails?.paymentToken).filter(Boolean);
  const refs = rows.map(r => r?.reference).filter(Boolean);
  const refOrderIds = refs.map(orderIdFromReference).filter((x): x is string => Boolean(x));

  const myShops = (await Business.find({ owner: userId }).select('_id').lean()).map(b => b._id);
  const orders = rows.length
    ? await Order.find({
        $and: [
          { $or: [{ user: userId }, { business: { $in: myShops } }] },
          {
            $or: [
              { paylukPaymentToken: { $in: tokens } },
              { 'payment.transactionRef': { $in: [...refs, ...tokens] } },
              { _id: { $in: refOrderIds } },
            ],
          },
        ],
      })
        .select(
          '_id user business orderNumber paylukPaymentToken payment.transactionRef paymentType paymentStatus payoutReleasedAt status'
        )
        .populate('user', 'firstName lastName')
        .populate('business', 'businessName')
        .lean()
    : [];

  const byToken = new Map<string, any>();
  const byRef = new Map<string, any>();
  const byId = new Map<string, any>();
  for (const o of orders as any[]) {
    if (o.paylukPaymentToken) byToken.set(o.paylukPaymentToken, o);
    if (o.payment?.transactionRef) byRef.set(o.payment.transactionRef, o);
    byId.set(String(o._id), o);
  }

  const data: ActivityRow[] = rows.map(t => {
    const order =
      byToken.get(t?.escrowDetails?.paymentToken) ??
      byRef.get(t?.reference) ??
      byId.get(orderIdFromReference(t?.reference) ?? '');
    const credit = t.creditType === 'credit';
    const isBuyer = order && String(order.user?._id ?? order.user) === userId;

    let type: ActivityType;
    if (t.transactionType === 'withdrawal') type = 'Withdrawal';
    else if (credit && isBuyer)
      type = 'Refund'; // money back to the buyer
    else type = credit ? 'Payment received' : 'Payment sent';

    let details = type === 'Withdrawal' ? 'To your bank' : 'Payment';
    if (order) {
      details = isBuyer
        ? `To ${order.business?.businessName ?? 'the shop'} · ${order.orderNumber}`
        : `From ${shortName(order.user?.firstName, order.user?.lastName)} · ${order.orderNumber}`;
    }

    let status = baseStatus(t.status);
    // Buyer-Protected money: held until confirmed, then released.
    if (
      status === 'Success' &&
      order &&
      order.paymentType !== 'normal' &&
      type !== 'Refund' &&
      order.paymentStatus === 'paid'
    ) {
      status = order.payoutReleasedAt ? 'Released' : 'Held';
    }

    return {
      id: String(t.id ?? ''),
      type,
      direction: credit ? 'credit' : 'debit',
      details,
      amount: Number(t.amount) || 0,
      fee: Number(t.fee) || 0,
      currency: normalizeCurrency(t.currency),
      status,
      date: t.createdAt ?? null,
      orderId: order ? String(order._id) : null,
    };
  });

  return { pagination: d?.pagination ?? null, data };
}

/**
 * Orders whose money is held in Buyer-Protected right now: the user's sales
 * waiting for the buyer, and their own purchases waiting for them to confirm.
 */
export async function heldOrders(userId: string) {
  const myShops = (await Business.find({ owner: userId }).select('_id').lean()).map(b => b._id);
  const orders = await Order.find({
    $or: [{ user: userId }, { business: { $in: myShops } }],
    paymentType: { $ne: 'normal' },
    paymentStatus: 'paid',
    payoutReleasedAt: { $exists: false },
    status: { $nin: ['refunded', 'cancelled'] },
  })
    .select('_id user business orderNumber itemsTotal items paidAt autoReleaseAt disputeStatus')
    .populate('user', 'firstName lastName')
    .populate('business', 'businessName')
    .sort({ paidAt: -1 })
    .limit(100)
    .lean();

  return (orders as any[]).map(o => {
    const isBuyer = String(o.user?._id ?? o.user) === userId;
    return {
      orderId: String(o._id),
      orderNumber: o.orderNumber,
      role: isBuyer ? 'buyer' : 'seller',
      name: isBuyer
        ? (o.business?.businessName ?? 'Shop')
        : shortName(o.user?.firstName, o.user?.lastName),
      amount: o.itemsTotal ?? o.items.reduce((s: number, i: any) => s + i.price * i.quantity, 0),
      paidAt: o.paidAt ?? null,
      autoReleaseAt: o.autoReleaseAt ?? null,
      problem: ['open', 'investigating'].includes(o.disputeStatus ?? ''),
    };
  });
}

export async function banks() {
  const d: any = await cached('banks:all:', BANKS_TTL, () => getBankList());
  const rows: any[] = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  return rows.map(b => ({ name: b.name, code: b.code }));
}

export async function verifyAccount(customerId: string, accountNumber: string, bankCode: string) {
  const d: any = await verifyBankAccount({ customerId, accountNumber, bankCode });
  return {
    accountName: d?.accountName ?? null,
    accountNumber: d?.accountNumber ?? accountNumber,
    bankCode,
  };
}

// ─── Withdrawals (two steps: create intent, then execute, with OTP if asked) ──

export async function startWithdrawal(
  userId: string,
  customerId: string,
  input: {
    amount: number;
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
    narration?: string;
  }
) {
  const reference = `wd-${userId}-${Date.now()}`;
  const d: any = await createWithdrawalIntent({ customerId, reference, ...input });
  return {
    reference: d?.reference ?? reference,
    amount: Number(d?.amount) || input.amount,
    fee: Number(d?.fee) || 0,
    status: d?.status ?? 'pending',
  };
}

export async function confirmWithdrawal(customerId: string, reference: string, otp?: string) {
  // Always sent with the user's OWN customer-id, so Payluk only executes an
  // intent that belongs to this customer.
  const d: any = await executePaymentIntent({ customerId, reference, otp });
  invalidateWalletCache(customerId);
  return {
    reference,
    status: d?.status ?? 'pending',
    amount: Number(d?.amount) || 0,
    fee: Number(d?.fee) || 0,
  };
}
