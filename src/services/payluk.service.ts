import axios, { AxiosInstance, AxiosError } from 'axios';

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const API_BASE = (process.env.PAYLUK_API_BASE || 'https://staging.api.payluk.ng').replace(/\/$/, '');
const SECRET   = process.env.PAYLUK_SECRET_KEY || '';

if (!SECRET) {
    console.warn('⚠️  PAYLUK_SECRET_KEY missing. Add to .env for Payluk integration.');
}

// ─────────────────────────────────────────────────────────────
// CUSTOM ERROR CLASS
// Gives callers structured access to error info
// ─────────────────────────────────────────────────────────────
export class PaylukError extends Error {
    public readonly statusCode: number;
    public readonly raw: unknown;

    constructor(message: string, statusCode = 500, raw?: unknown) {
        super(message);
        this.name       = 'PaylukError';
        this.statusCode = statusCode;
        this.raw        = raw;
    }
}

// ─────────────────────────────────────────────────────────────
// AXIOS INSTANCE
// Shared config, interceptors, and retry logic live here
// ─────────────────────────────────────────────────────────────
const paylukAxios: AxiosInstance = axios.create({
    baseURL: API_BASE,
    timeout: 15_000,
    headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${SECRET}`,
    },
});

// Request interceptor — attach auth header fresh on every call
// (handles hot-reloaded env vars in dev)
paylukAxios.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${SECRET}`;
    return config;
});

// Response interceptor — normalise errors into PaylukError
paylukAxios.interceptors.response.use(
    (res) => res,
    (err: AxiosError<{ message?: string; error?: string }>) => {
        const status  = err.response?.status ?? 500;
        const message =
            err.response?.data?.message ||
            err.response?.data?.error   ||
            err.message                 ||
            'Unknown Payluk error';

        console.error(`❌ [Payluk] ${status} – ${message}`, {
            url:  err.config?.url,
            body: err.config?.data,
        });

        return Promise.reject(new PaylukError(message, status, err.response?.data));
    },
);

// ─────────────────────────────────────────────────────────────
// RETRY HELPER
// Retries idempotent requests up to `maxRetries` times
// with exponential backoff (only on network / 5xx errors)
// ─────────────────────────────────────────────────────────────
async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 2,
    label      = 'Payluk',
): Promise<T> {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable =
                err instanceof PaylukError && err.statusCode >= 500;

            if (!isRetryable || attempt >= maxRetries) throw err;

            const delay = 300 * 2 ** attempt; // 300ms, 600ms …
            console.warn(`⚠️  [${label}] Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms…`);
            await new Promise((r) => setTimeout(r, delay));
            attempt++;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// SAFE DATA EXTRACTOR
// Payluk sometimes nests under data.data and sometimes not
// ─────────────────────────────────────────────────────────────
function extractData<T>(raw: unknown): T {
    return ((raw as any)?.data ?? raw) as T;
}

// ---------- Customer ----------
export type CreateCustomerOpts = {
    firstName: string;
    lastName:  string;
    email:     string;
    phone?:    string;
};

export type CreateCustomerResult = {
    raw:        unknown;
    customerId: string;
};

// ---------- Escrow ----------
export type CreatePaymentLinkOpts = {
    /** Amount in NGN (e.g. 5000 for ₦5,000) */
    amount:           number;
    /** Short title e.g. "iPhone 18 Purchase" */
    purpose:          string;
    /** Longer product/order description */
    description?:     string;
    /** Who bears the escrow fee. Defaults to 'buyer' */
    whoPays?:         'buyer' | 'seller' | 'both';
    /** Delivery window number (e.g. 3) */
    maxDelivery?:     number;
    /** Unit for maxDelivery */
    deliveryTimeline?: 'hours' | 'days' | 'minutes';
    /** Total quantity of items */
    totalQuantity?:   number;
    /** Optional Payluk category ID */
    categoryId?:      string;
    /** Optional product image URL */
    imageUrl?:        string | null;
    /** Redirect URL after payment */
    callbackUrl?:     string;
    /** The BUYER's Payluk customer ID (sent as customer-id header) */
    customerId:       string;
};

export type CreatePaymentLinkResult = {
    raw:          unknown;
    escrowId:     string;
    paymentToken: string;
    paymentUrl?:  string;
    fee:          number;
    payableAmount: number; // amount + fee — what the buyer actually sends
};

// ---------- Payment ----------
export type InitPaymentOpts = {
    /** Amount in NGN — must match the escrow amount */
    amount:      number;
    /** From createEscrow result */
    escrowId:    string;
    /** Your internal order/reference ID */
    orderId:     string;
    /** The BUYER's Payluk customer ID */
    customerId:  string;
    gateway?:    'wallet' | 'card';
    /** Only required when gateway === 'card' */
    cardId?:     string;
};

export type InitPaymentResult = {
    raw:           unknown;
    paymentToken?: string;
    paymentUrl?:   string;
};

// ---------- Verify ----------
export type VerifyPaymentResult = {
    raw:            unknown;
    status:         string;
    transactionRef?: string;
    amount?:        number;
    metadata:       Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────
// SERVICE METHODS
// ─────────────────────────────────────────────────────────────

/**
 * Create a Payluk customer profile.
 * POST /v1/customer/create
 */
export const createPaylukCustomer = async (
    opts: CreateCustomerOpts,
): Promise<CreateCustomerResult> =>
    withRetry(async () => {
        console.log('🔍 [createPaylukCustomer]', { email: opts.email });

        const resp = await paylukAxios.post('/v1/customer/create', {
            firstname: opts.firstName,
            lastname:  opts.lastName,
            email:     opts.email,
            ...(opts.phone && { phone: opts.phone }),
        });

        const data       = extractData<Record<string, any>>(resp.data);
        const customerId = data?.id || data?._id || data?.customerId;

        if (!customerId) {
            throw new PaylukError('Payluk did not return a customerId', 502, resp.data);
        }

        return { raw: resp.data, customerId };
    }, 2, 'createPaylukCustomer');


/**
 * Seller creates an escrow payment link.
 * POST /v1/escrow/create
 *
 * The buyer's customerId is sent as the `customer-id` header so Payluk
 * links this escrow to the correct buyer account.
 */
export const createPaymentLink = async (
    opts: CreatePaymentLinkOpts,
): Promise<CreatePaymentLinkResult> =>
    withRetry(async () => {
        console.log('🔍 [createEscrow]:', { amount: opts.amount, purpose: opts.purpose });

        const resp = await paylukAxios.post(
            '/v1/escrow/create',
            {
                amount:           opts.amount,
                purpose:          opts.purpose,
                description:      opts.description || opts.purpose,
                whoPays:          opts.whoPays        || 'buyer',
                maxDelivery:      opts.maxDelivery    ?? 3,
                deliveryTimeline: opts.deliveryTimeline || 'days',
                totalQuantity:    opts.totalQuantity  ?? 1,
                ...(opts.categoryId  && { categoryId:  opts.categoryId }),
                ...(opts.imageUrl    && { imageUrl:    opts.imageUrl }),
                ...(opts.callbackUrl && { callbackUrl: opts.callbackUrl }),
            },
            { headers: { 'customer-id': opts.customerId } },
        );

        const data         = extractData<Record<string, any>>(resp.data);
        const escrowId     = data?.id     || data?.escrowId    || data?._id;
        const paymentToken = data?.paymentToken || data?.token || data?.payment_token;
        const paymentUrl   = data?.paymentUrl   || data?.url   || data?.payment_url;
        const fee          = Number(data?.fee ?? data?.escrowFee ?? data?.transactionFee ?? 0);
        const payableAmount = Number(data?.payableAmount ?? data?.totalAmount ?? data?.amount ?? opts.amount) + (fee && !data?.payableAmount ? fee : 0);

        if (!escrowId) {
            throw new PaylukError('Payluk createEscrow did not return an escrowId', 502, resp.data);
        }
        if (!paymentToken) {
            throw new PaylukError('Payluk createEscrow did not return a paymentToken', 502, resp.data);
        }

        console.log('🔍 [createEscrow] fee:', fee, 'payableAmount:', payableAmount, 'raw data keys:', Object.keys(data ?? {}));
        return { raw: resp.data, escrowId, paymentToken, paymentUrl, fee, payableAmount };
    }, 2, 'createEscrow');


/**
 * Buyer pays into the escrow.
 * POST /v1/payment/escrow
 *
 * Call this AFTER createEscrow — pass the escrowId from that result.
 */
export const initEscrowPayment = async (
    opts: InitPaymentOpts,
): Promise<InitPaymentResult> =>
    withRetry(async () => {
        console.log('🔍 [initEscrowPayment]', { escrowId: opts.escrowId, gateway: opts.gateway });

        const payload: Record<string, unknown> = {
            amount:          opts.amount,
            reference:       `order_${opts.orderId}_${Date.now()}`,
            gateway:         opts.gateway || 'card',
            transactionType: 'escrow',
            escrowDetails:   { escrowId: [opts.escrowId] },
        };

        if (opts.gateway === 'card' && opts.cardId) {
            payload.cardId = opts.cardId;
        }

        const resp = await paylukAxios.post('/v1/payment/escrow', payload, {
            headers: { 'customer-id': opts.customerId },
        });

        const data         = extractData<Record<string, any>>(resp.data);
        const paymentToken = data?.paymentToken || data?.token || data?.payment_token || data?.reference;
        const paymentUrl   = data?.paymentUrl   || data?.url   || data?.payment_url;

        return { raw: resp.data, paymentToken, paymentUrl };
    }, 2, 'initEscrowPayment');


/**
 * Add an "additional fee" on top of an escrow (delivery + platform's cut).
 * PUT /v1/escrow/additional-fee/:paymentToken
 *
 * The whole additionalFee is credited to OUR platform merchant wallet — Payluk
 * takes no cut and it is NOT part of the escrow amount, so the seller's payout
 * (the escrow amount) is unchanged. This is how we separate delivery fees +
 * platform commission from the seller's money.
 *
 * Must be called while the escrow is still AWAITING_PAYMENT (before the buyer
 * pays). Uses the platform secret key and MUST NOT send a customer-id header
 * (paylukAxios only adds customer-id per-call, so a plain PUT is correct).
 */
export type UpdateAdditionalFeeResult = {
    raw:            unknown;
    additionalFee:  number;
    payableAmount?: number;
};

export const updateAdditionalFee = async (
    paymentToken:  string,
    additionalFee: number,
    refundable = true,
): Promise<UpdateAdditionalFeeResult> =>
    withRetry(async () => {
        const fee = Math.max(0, Math.round(additionalFee));
        console.log('🔍 [updateAdditionalFee]', { paymentToken, additionalFee: fee });

        const resp = await paylukAxios.put(
            `/v1/escrow/additional-fee/${paymentToken}`,
            { additionalFee: fee, additionalFeeRefundable: refundable },
        );

        const data = extractData<Record<string, any>>(resp.data);
        return {
            raw:            resp.data,
            additionalFee:  Number(data?.additionalFee ?? fee),
            payableAmount:  data?.payableAmount != null ? Number(data.payableAmount) : undefined,
        };
    }, 2, 'updateAdditionalFee');


/**
 * Verify an escrow payment by its paymentToken or paymentId.
 * GET /v1/escrow/verify/:paymentId
 *
 * Call this server-side after receiving a webhook or client callback
 * to confirm payment before releasing goods/services.
 */
export const verifyPaymentToken = async (
    paymentToken: string,
): Promise<VerifyPaymentResult> =>
    withRetry(async () => {
        console.log('🔍 [verifyPaymentToken]', { paymentToken });

        const resp = await paylukAxios.get(
            `/v1/escrow/verify/${encodeURIComponent(paymentToken)}`,
        );

        const data = extractData<Record<string, any>>(resp.data);

        return {
            raw:            resp.data,
            status:         data?.status || resp.data?.status,
            transactionRef: data?.transactionRef || data?.trx_ref || data?.reference,
            amount:         data?.amount,
            metadata:       data?.metadata || {},
        };
    }, 2, 'verifyPaymentToken');