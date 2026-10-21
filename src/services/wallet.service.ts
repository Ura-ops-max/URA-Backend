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
  listEscrows,
  verifyBankAccount,
} from '@/services/payluk.service';

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

export const walletBalance = (customerId: string) =>
  cached(`wallet:${customerId}:`, WALLET_TTL, () => getWallet(customerId));

export async function walletTransactions(customerId: string, page = 1, limit = 20, type?: string) {
  const d: any = await cached(
    `history:${customerId}:${page}:${limit}:${type ?? ''}`,
    LIST_TTL,
    () => getPaymentHistory({ customerId, page, limit, ...(type ? { type } : {}) })
  );
  const rows: any[] = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
  // The fields the wallet screens show (same names as Payluk's), nothing more.
  return {
    pagination: d?.pagination ?? null,
    data: rows.map(t => ({
      id: t.id,
      reference: t.reference,
      amount: Number(t.amount) || 0,
      fee: Number(t.fee) || 0,
      currency: t.currency || 'NGN',
      transactionType: t.transactionType,
      creditType: t.creditType, // credit | debit
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  };
}

/**
 * Escrows the user bought (type=buy) or sold (type=sales), each linked to its
 * URA order when there is one, so actions go through /orders/:id/… routes.
 */
export async function walletEscrows(
  userId: string,
  customerId: string,
  type: 'buy' | 'sales',
  page = 1,
  status?: string
) {
  const d: any = await cached(
    `escrows:${customerId}:${type}:${page}:${status ?? ''}`,
    LIST_TTL,
    () => listEscrows({ customerId, type, page, limit: 20, ...(status ? { status } : {}) })
  );
  const rows: any[] = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];

  // Only the user's own orders are linked.
  const ids = rows.map(r => String(r.id)).filter(Boolean);
  const scope =
    type === 'buy'
      ? { user: userId }
      : {
          business: {
            $in: (await Business.find({ owner: userId }).select('_id').lean()).map(b => b._id),
          },
        };
  const orders = ids.length
    ? await Order.find({ ...scope, paylukEscrowId: { $in: ids } })
        .select('_id orderNumber paylukEscrowId paymentType')
        .lean()
    : [];
  const byEscrow = new Map(orders.map((o: any) => [String(o.paylukEscrowId), o]));

  // Same field names as Payluk's, minus the payment token: actions on an
  // escrow go through its URA order (/orders/:id/...), never by token.
  return {
    pagination: d?.pagination ?? null,
    report: d?.report ?? null,
    data: rows.map(r => {
      const o: any = byEscrow.get(String(r.id));
      return {
        id: r.id,
        purpose: r.purpose,
        description: r.description ?? '',
        amount: Number(r.amount) || 0,
        fee: Number(r.fee) || 0,
        whoPays: r.whoPays,
        status: r.status,
        state: r.state,
        channel: r.channel,
        maxDelivery: r.maxDelivery,
        deliveryTimeline: r.deliveryTimeline,
        totalQuantity: r.totalQuantity,
        paidAt: r.paidAt ?? null,
        completedAt: r.completedAt ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        paymentDetails: r.paymentDetails
          ? { amount: Number(r.paymentDetails.amount) || 0, status: r.paymentDetails.status }
          : null,
        orderId: o ? String(o._id) : null,
        orderNumber: o?.orderNumber ?? null,
        paymentType: o?.paymentType ?? null,
      };
    }),
  };
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
