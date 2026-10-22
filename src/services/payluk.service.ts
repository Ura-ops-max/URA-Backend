/**
 * The only Payluk client in URA. Every Payluk call, from any route or job,
 * goes through `paylukRequest` here, so these rules hold everywhere:
 *
 *  - The secret key is added here and never logged. Request bodies are never
 *    logged either (they can hold bank details); logs show method, path,
 *    status and time only, with payment tokens shortened.
 *  - Payluk allows 10 requests a minute per secret key, across ALL routes
 *    (docs: Authentication > Rate limits). A shared queue keeps URA under that,
 *    serves checkout and release calls before wallet screens, and reads
 *    Payluk's `RateLimit` header to back off before a 429.
 *  - Timeouts on every call. Retries with backoff on 429, and on 5xx/network
 *    errors only for calls that are safe to repeat.
 *
 * Docs: https://docs.payluk.ng (llms.txt, openapi.json).
 */
import axios, { AxiosError, AxiosResponse } from 'axios';

// Node 18+ built-ins (spec FormData/Blob, which axios sends as multipart).
const { FormData, Blob } = globalThis;

const API_BASE = (
  process.env.PAYLUK_BASE_URL ||
  process.env.PAYLUK_API_BASE ||
  'https://staging.api.payluk.ng'
).replace(/\/$/, '');
const SECRET = process.env.PAYLUK_SECRET_KEY || '';
const TIMEOUT_MS = 15_000;
const LIMIT_PER_MIN = Math.max(1, Number(process.env.PAYLUK_RATE_LIMIT_PER_MIN) || 10);

if (!SECRET) console.warn('⚠️  PAYLUK_SECRET_KEY is not set. Payluk calls will fail.');

// ─── Errors ──────────────────────────────────────────────────────────────────

export type PaylukErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED' // 401: e.g. a non-super-admin key on a super-admin route
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'GONE'
  | 'RATE_LIMITED'
  | 'BUSY' // our own queue: waited too long for a free slot
  | 'SERVER'
  | 'NETWORK';

export class PaylukError extends Error {
  public readonly statusCode: number;
  public readonly code: PaylukErrorCode;
  public readonly raw: unknown;

  constructor(message: string, statusCode = 500, code: PaylukErrorCode = 'SERVER', raw?: unknown) {
    super(message);
    this.name = 'PaylukError';
    this.statusCode = statusCode;
    this.code = code;
    this.raw = raw;
  }

  /** Worth trying again later (rate limit, Payluk down, network). */
  get retryable(): boolean {
    return ['RATE_LIMITED', 'BUSY', 'SERVER', 'NETWORK'].includes(this.code);
  }
}

const codeForStatus = (s: number): PaylukErrorCode =>
  s === 400 || s === 422
    ? 'BAD_REQUEST'
    : s === 401
      ? 'UNAUTHORIZED'
      : s === 403
        ? 'FORBIDDEN'
        : s === 404
          ? 'NOT_FOUND'
          : s === 410
            ? 'GONE'
            : s === 429
              ? 'RATE_LIMITED'
              : 'SERVER';

// ─── Rate limit queue (shared by every caller in this process) ───────────────

export type Priority = 'high' | 'normal' | 'background';
const PRIORITY_ORDER: Priority[] = ['high', 'normal', 'background'];

interface Waiter {
  priority: Priority;
  resolve: () => void;
  reject: (e: Error) => void;
  deadline: number;
}

class RateLimiter {
  private stamps: number[] = [];
  private blockedUntil = 0;
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly perMinute: number) {}

  acquire(priority: Priority, maxWaitMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ priority, resolve, reject, deadline: Date.now() + maxWaitMs });
      this.pump();
    });
  }

  /** Payluk told us how many calls are left in this window. */
  noteHeaders(res: AxiosResponse | undefined): void {
    const header = res?.headers?.['ratelimit'];
    if (typeof header !== 'string') return;
    const remaining = Number(/remaining=(\d+)/.exec(header)?.[1]);
    const reset = Number(/reset=(\d+)/.exec(header)?.[1]);
    if (remaining === 0 && reset > 0) this.block(reset * 1000);
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.schedule(ms);
  }

  private pump(): void {
    const now = Date.now();
    this.stamps = this.stamps.filter(t => now - t < 60_000);

    // Give up on callers that have waited too long.
    for (const w of [...this.waiters]) {
      if (w.deadline <= now) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.reject(new PaylukError('Payments are busy. Please try again in a moment.', 503, 'BUSY'));
      }
    }

    while (this.waiters.length && now >= this.blockedUntil && this.stamps.length < this.perMinute) {
      const next = PRIORITY_ORDER.map(p => this.waiters.find(w => w.priority === p)).find(Boolean)!;
      this.waiters.splice(this.waiters.indexOf(next), 1);
      this.stamps.push(now);
      next.resolve();
    }

    if (this.waiters.length) {
      const untilSlot = this.stamps.length >= this.perMinute ? 60_000 - (now - this.stamps[0]) : 0;
      const untilUnblock = Math.max(0, this.blockedUntil - now);
      const untilDeadline = Math.min(...this.waiters.map(w => w.deadline - now));
      this.schedule(Math.max(50, Math.min(Math.max(untilSlot, untilUnblock), untilDeadline)));
    }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, ms);
    this.timer.unref?.();
  }
}

const limiter = new RateLimiter(LIMIT_PER_MIN);

// ─── Core request ────────────────────────────────────────────────────────────

const http = axios.create({ baseURL: API_BASE, timeout: TIMEOUT_MS });

export interface PaylukRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // e.g. '/v1/wallet'
  /** Acts on behalf of this merchant customer (buyer or seller). */
  customerId?: string | undefined;
  json?: unknown;
  form?: InstanceType<typeof FormData>;
  query?: Record<string, string | number | undefined>;
  priority?: Priority;
  /** Safe to repeat after a 5xx/network error (GETs, idempotent references). */
  idempotent?: boolean;
  /** How long to wait for a free rate-limit slot before giving up. */
  maxQueueMs?: number;
}

/** Shorten payment tokens in paths so logs can't be used to pay or look up. */
const safePath = (p: string) =>
  p.replace(/(verify|additional-fee|claim-funds|submit-dispute)\/([^/?]{6})[^/?]*/g, '$1/$2…');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function paylukRequest<T = any>(req: PaylukRequest): Promise<T> {
  if (!SECRET) throw new PaylukError('Payments are not configured.', 503, 'SERVER');

  const priority = req.priority ?? 'normal';
  const maxQueueMs = req.maxQueueMs ?? (priority === 'background' ? 10 * 60_000 : 20_000);
  const maxAttempts = 4;

  for (let attempt = 1; ; attempt++) {
    await limiter.acquire(priority, maxQueueMs);
    const started = Date.now();
    try {
      const res = await http.request({
        method: req.method,
        url: req.path,
        params: req.query,
        data: req.form ?? req.json,
        headers: {
          Authorization: `Bearer ${SECRET}`,
          accept: 'application/json',
          ...(req.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(req.customerId ? { 'customer-id': req.customerId } : {}),
        },
      });
      limiter.noteHeaders(res);
      console.log(
        `[payluk] ${req.method} ${safePath(req.path)} ${res.status} ${Date.now() - started}ms`
      );
      // Envelope: { status, message, data }.
      return ((res.data as any)?.data ?? res.data) as T;
    } catch (e) {
      const err = e as AxiosError<any>;
      const status = err.response?.status ?? 0;
      limiter.noteHeaders(err.response);
      const body = err.response?.data;
      const message =
        (typeof body === 'string' && body.slice(0, 200)) ||
        body?.message ||
        body?.error?.message ||
        body?.error ||
        (status
          ? `Payluk returned ${status}`
          : `Could not reach Payluk (${err.code ?? 'network'})`);
      const code: PaylukErrorCode = status ? codeForStatus(status) : 'NETWORK';
      console.warn(
        `[payluk] ${req.method} ${safePath(req.path)} ${status || err.code} ${Date.now() - started}ms: ${String(message).slice(0, 160)}`
      );

      const retry =
        attempt < maxAttempts &&
        (code === 'RATE_LIMITED' || ((code === 'SERVER' || code === 'NETWORK') && req.idempotent));
      if (!retry) throw new PaylukError(String(message), status || 502, code, body);

      if (code === 'RATE_LIMITED') {
        const reset = Number(/reset=(\d+)/.exec(String(err.response?.headers?.['ratelimit']))?.[1]);
        limiter.block((reset > 0 ? reset : 60) * 1000);
      } else {
        await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
      }
    }
  }
}

// ─── Escrow helpers ──────────────────────────────────────────────────────────

export type WhoPays = 'buyer' | 'seller' | 'both';
export type EscrowState = 'AWAITING_PAYMENT' | 'OPENED' | 'CLOSED';
export type EscrowStatus =
  | 'PENDING'
  | 'ONGOING'
  | 'COMPLETED'
  | 'REFUNDED'
  | 'CLAIMED'
  | 'DISPUTED'
  | 'INVESTIGATING'
  | 'SPLIT';

export interface Escrow {
  id: string;
  paymentToken: string;
  amount: number;
  fee: number;
  additionalFee: number;
  additionalFeeRefundable: boolean;
  whoPays: WhoPays;
  status: EscrowStatus;
  state: EscrowState;
  paidAt?: string | null;
  completedAt?: string | null;
  totalQuantity?: number;
  /** On SPLIT: how the held money was divided. */
  split?: { sellerAmount?: number; buyerAmount?: number; pool?: number } | null;
}

export const toEscrow = (d: any): Escrow => ({
  id: String(d?.id ?? ''),
  paymentToken: String(d?.paymentToken ?? ''),
  amount: Number(d?.amount) || 0,
  fee: Number(d?.fee) || 0,
  additionalFee: Number(d?.additionalFee) || 0,
  additionalFeeRefundable: d?.additionalFeeRefundable !== false,
  whoPays: (d?.whoPays as WhoPays) || 'buyer',
  status: String(d?.status ?? '').toUpperCase() as EscrowStatus,
  state: String(d?.state ?? '').toUpperCase() as EscrowState,
  paidAt: d?.paidAt ?? null,
  completedAt: d?.completedAt ?? null,
  totalQuantity: d?.totalQuantity,
  split: d?.split ?? null,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The buyer's share of Payluk's fee (docs: Fees & settlement > Who pays). */
export const buyerFeeShare = (e: Pick<Escrow, 'fee' | 'whoPays'>): number =>
  e.whoPays === 'buyer' ? e.fee : e.whoPays === 'both' ? round2(e.fee / 2) : 0;

/** What the buyer must pay: amount + their fee share + additionalFee. */
export const amountToPay = (e: Pick<Escrow, 'amount' | 'fee' | 'whoPays' | 'additionalFee'>) =>
  round2(e.amount + buyerFeeShare(e) + e.additionalFee);

/** The escrow has been funded (and may since have closed). */
export const isFunded = (e: Pick<Escrow, 'state' | 'status'>): boolean =>
  e.state === 'OPENED' || (e.state === 'CLOSED' && e.status !== 'PENDING');

// ─── Customers ───────────────────────────────────────────────────────────────

export type CreateCustomerOpts = {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
};

/** POST /v1/customer/create (super-admin key, no customer-id). */
export async function createPaylukCustomer(
  opts: CreateCustomerOpts
): Promise<{ customerId: string }> {
  const data = await paylukRequest({
    method: 'POST',
    path: '/v1/customer/create',
    priority: 'high',
    json: {
      firstname: opts.firstName,
      lastname: opts.lastName,
      email: opts.email,
      // Docs: digits only, no leading "+".
      ...(opts.phone ? { phone: String(opts.phone).replace(/\D/g, '') } : {}),
    },
  });
  const customerId = data?.id || data?._id || data?.customerId;
  if (!customerId) throw new PaylukError('Payluk did not return a customer id', 502, 'SERVER');
  return { customerId: String(customerId) };
}

// ─── Escrows ─────────────────────────────────────────────────────────────────

export interface CreateEscrowOpts {
  /** The SELLER's Payluk customer id (the escrow is created on their behalf). */
  sellerCustomerId: string;
  amount: number;
  purpose: string;
  description?: string;
  whoPays: WhoPays;
  maxDelivery: number;
  deliveryTimeline: 'minutes' | 'hours' | 'days';
}

/**
 * POST /v1/escrow/create (multipart/form-data, customer-id = seller).
 * Always ONE escrow per order: totalQuantity 1. A higher totalQuantity turns
 * the escrow into a reusable listing that Payluk clones at payment time, with
 * a new id we would never see (docs: Multi-quantity escrows).
 * Not retried on 5xx: a retry could create a second escrow.
 */
export async function createEscrow(opts: CreateEscrowOpts): Promise<Escrow> {
  const form = new FormData();
  form.append('amount', String(round2(opts.amount)));
  form.append('purpose', opts.purpose.slice(0, 120));
  if (opts.description) form.append('description', opts.description.slice(0, 500));
  form.append('whoPays', opts.whoPays);
  form.append('maxDelivery', String(Math.min(365, Math.max(1, Math.round(opts.maxDelivery)))));
  form.append('deliveryTimeline', opts.deliveryTimeline);
  form.append('totalQuantity', '1');
  // imageUrl is a FILE upload field on Payluk (up to 5 images), not a link,
  // so product photos are not sent; the escrow works without them.

  const data = await paylukRequest({
    method: 'POST',
    path: '/v1/escrow/create',
    customerId: opts.sellerCustomerId,
    form,
    priority: 'high',
  });
  const escrow = toEscrow(data);
  if (!escrow.id || !escrow.paymentToken) {
    throw new PaylukError('Payluk did not return an escrow id and payment token', 502, 'SERVER');
  }
  return escrow;
}

/**
 * PUT /v1/escrow/additional-fee/{paymentToken} (super-admin key, NO customer-id).
 * Paid in full to URA's merchant wallet when the escrow completes; not part of
 * the seller's payout. Only allowed while the escrow is AWAITING_PAYMENT.
 */
export async function setAdditionalFee(
  paymentToken: string,
  additionalFee: number
): Promise<Escrow> {
  const data = await paylukRequest({
    method: 'PUT',
    path: `/v1/escrow/additional-fee/${encodeURIComponent(paymentToken)}`,
    json: { additionalFee: Math.max(0, Math.round(additionalFee)) },
    priority: 'high',
    idempotent: true, // a plain setter
  });
  return toEscrow(data);
}

/** GET /v1/escrow/verify/{paymentToken}: the escrow as Payluk sees it now. */
export async function verifyEscrow(
  paymentToken: string,
  priority: Priority = 'high'
): Promise<Escrow> {
  const data = await paylukRequest({
    method: 'GET',
    path: `/v1/escrow/verify/${encodeURIComponent(paymentToken)}`,
    priority,
    idempotent: true,
  });
  return toEscrow(data);
}

/**
 * POST /v1/payment/escrow with gateway "wallet" (customer-id = buyer).
 * `amount` must equal what the buyer owes, or Payluk answers "Amount mismatch".
 * Repeating the same reference is idempotent (docs: Pay escrow).
 */
export async function payEscrowFromWallet(opts: {
  buyerCustomerId: string;
  escrowId: string;
  amount: number;
  reference: string;
}): Promise<void> {
  await paylukRequest({
    method: 'POST',
    path: '/v1/payment/escrow',
    customerId: opts.buyerCustomerId,
    json: {
      amount: round2(opts.amount),
      reference: opts.reference,
      transactionType: 'escrow',
      gateway: 'wallet',
      escrowDetails: { escrowId: opts.escrowId },
    },
    priority: 'high',
    idempotent: true,
  });
}

/**
 * POST /v1/escrow/confirm-payment/{escrowId} (customer-id = buyer).
 * Releases the escrow to the seller. Needs a super-admin key (else 401).
 */
export async function confirmEscrow(
  escrowId: string,
  buyerCustomerId: string,
  priority: Priority = 'high'
): Promise<Escrow> {
  const data = await paylukRequest({
    method: 'POST',
    path: `/v1/escrow/confirm-payment/${encodeURIComponent(escrowId)}`,
    customerId: buyerCustomerId,
    priority,
  });
  return toEscrow(data);
}

/** GET /v1/escrow/claim-funds/{paymentToken} (customer-id = seller). */
export async function claimEscrow(paymentToken: string, sellerCustomerId: string): Promise<Escrow> {
  const data = await paylukRequest({
    method: 'GET',
    path: `/v1/escrow/claim-funds/${encodeURIComponent(paymentToken)}`,
    customerId: sellerCustomerId,
    priority: 'high',
  });
  return toEscrow(data);
}

/** POST /v1/escrow/submit-dispute/{paymentToken} (multipart; buyer opens, seller replies). */
export async function submitDispute(opts: {
  paymentToken: string;
  customerId: string;
  message: string;
  file?: { buffer: Buffer; filename: string; mimetype: string } | undefined;
}): Promise<Escrow> {
  const form = new FormData();
  form.append('message', opts.message.slice(0, 2000));
  if (opts.file) {
    form.append(
      'file',
      new Blob([new Uint8Array(opts.file.buffer)], { type: opts.file.mimetype }),
      opts.file.filename
    );
  }
  const data = await paylukRequest({
    method: 'POST',
    path: `/v1/escrow/submit-dispute/${encodeURIComponent(opts.paymentToken)}`,
    customerId: opts.customerId,
    form,
    priority: 'high',
  });
  return toEscrow(data);
}

/** GET /v1/escrow/dispute/get/{escrowId} (customer-id = a party to the escrow). */
export async function getDispute(escrowId: string, customerId: string): Promise<any> {
  return paylukRequest({
    method: 'GET',
    path: `/v1/escrow/dispute/get/${encodeURIComponent(escrowId)}`,
    customerId,
    idempotent: true,
  });
}

/** GET /v1/escrow/transactions?type=buy|sales (customer-id = that customer). */
export async function listEscrows(opts: {
  customerId: string;
  type: 'buy' | 'sales';
  page?: number;
  limit?: number;
  status?: string;
}): Promise<any> {
  return paylukRequest({
    method: 'GET',
    path: '/v1/escrow/transactions',
    customerId: opts.customerId,
    query: { type: opts.type, page: opts.page, limit: opts.limit, status: opts.status },
    idempotent: true,
  });
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

/** GET /v1/wallet (customer-id required): mainBalance and escrowBalance. */
export async function getWallet(
  customerId: string,
  priority: Priority = 'normal'
): Promise<{ mainBalance: number; escrowBalance: number; currency: string }> {
  const d = await paylukRequest({
    method: 'GET',
    path: '/v1/wallet',
    customerId,
    priority,
    idempotent: true,
  });
  return {
    mainBalance: Number(d?.mainBalance) || 0,
    escrowBalance: Number(d?.escrowBalance) || 0,
    currency: d?.currency || 'NGN',
  };
}

/** GET /v1/payment/history (customer-id required). limit 1..100. */
export async function getPaymentHistory(opts: {
  customerId: string;
  page?: number;
  limit?: number;
  type?: string;
}): Promise<any> {
  return paylukRequest({
    method: 'GET',
    path: '/v1/payment/history',
    customerId: opts.customerId,
    query: {
      page: opts.page,
      limit: opts.limit ? Math.min(100, Math.max(1, opts.limit)) : undefined,
      type: opts.type,
    },
    idempotent: true,
  });
}

/** GET /v1/payment/bank-list. */
export async function getBankList(): Promise<any> {
  return paylukRequest({ method: 'GET', path: '/v1/payment/bank-list', idempotent: true });
}

/** POST /v1/payment/verify-account: resolve the name on a bank account. */
export async function verifyBankAccount(opts: {
  customerId: string;
  accountNumber: string;
  bankCode: string;
}): Promise<any> {
  return paylukRequest({
    method: 'POST',
    path: '/v1/payment/verify-account',
    customerId: opts.customerId,
    json: { accountNumber: opts.accountNumber, bankCode: opts.bankCode },
    idempotent: true,
  });
}

/**
 * Withdrawal step 1: POST /v1/payment/create-intent (transactionType withdrawal).
 * Stages the payout; no money moves. Returns the intent (reference, fee).
 */
export async function createWithdrawalIntent(opts: {
  customerId: string;
  amount: number;
  reference: string;
  accountName: string;
  accountNumber: string;
  bankName: string;
  bankCode: string;
  narration?: string;
}): Promise<any> {
  return paylukRequest({
    method: 'POST',
    path: '/v1/payment/create-intent',
    customerId: opts.customerId,
    json: {
      amount: round2(opts.amount),
      reference: opts.reference,
      transactionType: 'withdrawal',
      withdrawalDetails: {
        accountName: opts.accountName,
        accountNumber: opts.accountNumber,
        bankName: opts.bankName,
        bankCode: opts.bankCode,
        ...(opts.narration ? { narration: opts.narration } : {}),
      },
    },
    priority: 'high',
  });
}

/** Withdrawal step 2: POST /v1/payment/verify executes the intent (with OTP if asked). */
export async function executePaymentIntent(opts: {
  customerId: string;
  reference: string;
  otp?: string | undefined;
}): Promise<any> {
  return paylukRequest({
    method: 'POST',
    path: '/v1/payment/verify',
    customerId: opts.customerId,
    json: { reference: opts.reference, ...(opts.otp ? { otp: opts.otp } : {}) },
    priority: 'high',
    idempotent: true, // docs: verifying the same reference again is idempotent
  });
}

/**
 * POST /v1/escrow/dispute/resolve/{escrowId} with status REFUNDED: return the
 * held money to the buyer. Merchant-only: super-admin key, NO customer-id.
 * Payluk only allows this once the buyer has opened a dispute ("No dispute
 * found for this escrow" otherwise). multipart/form-data per the docs.
 */
export async function resolveDisputeAsRefund(opts: {
  escrowId: string;
  resolution: string;
  /** true: the delivery fee goes back to the buyer too (nothing was delivered). */
  additionalFeeRefundable: boolean;
}): Promise<Escrow> {
  const form = new FormData();
  form.append('resolution', opts.resolution.slice(0, 1000));
  form.append('status', 'REFUNDED');
  form.append('additionalFeeRefundable', String(opts.additionalFeeRefundable));
  const data = await paylukRequest({
    method: 'POST',
    path: `/v1/escrow/dispute/resolve/${encodeURIComponent(opts.escrowId)}`,
    form,
    priority: 'high',
  });
  return toEscrow(data);
}
