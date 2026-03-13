import axios from 'axios';

// Strip trailing slash to avoid double-slash in paths
const API_BASE = (process.env.PAYLUK_API_BASE || 'https://staging.api.payluk.ng').replace(/\/$/, '');
const SECRET = process.env.PAYLUK_SECRET_KEY || '';

if (!SECRET) {
    console.warn('⚠️  PAYLUK_SECRET_KEY missing. Add to .env for Payluk integration.');
}

// Base headers — customer-id is added per-call where required
const baseHeaders = () => ({
    Authorization: `Bearer ${SECRET}`,
    'Content-Type': 'application/json'
});


// ─────────────────────────────────────────────
// Create a Payluk customer profile
// POST /v1/customer/create
// ─────────────────────────────────────────────
type CreateCustomerOpts = {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    bvn: string;
};

export type CreateCustomerResult = {
    raw: any;
    customerId: string;
};

export const createPaylukCustomer = async (opts: CreateCustomerOpts): Promise<CreateCustomerResult> => {
    const url = `${API_BASE}/v1/customer/create`;

    const payload = {
        firstname: opts.firstName,
        lastname: opts.lastName,
        email: opts.email,
        phone: opts.phone,
        bvn: opts.bvn,
    };

    console.log('🔍 [createPaylukCustomer] URL:', url);
    console.log('🔍 [createPaylukCustomer] Payload:', payload);

    const resp = await axios.post(url, payload, {
        headers: baseHeaders(),
        timeout: 15_000
    });

    const data = resp.data?.data || resp.data;
    const customerId = data?.id || data?._id || data?.customerId;

    if (!customerId) {
        console.error('❌ [createPaylukCustomer] No customerId in response:', resp.data);
        throw new Error('Payluk did not return a customerId');
    }

    return { raw: resp.data, customerId };
};

// ─────────────────────────────────────────────
// STEP 1: Seller creates the escrow payment link
// POST /v1/escrow/create
// ─────────────────────────────────────────────
type CreateEscrowOpts = {
    amount: number;           // Amount in NGN (e.g. 5000 for ₦5,000)
    purpose: string;          // Short title e.g. "iPhone 18 Purchase"
    description?: string;     // Longer product/order description
    whoPays?: 'buyer' | 'seller'; // Who bears the escrow fee. Defaults to 'buyer'
    maxDelivery?: number;     // Delivery window number (e.g. 3)
    deliveryTimeline?: 'hours' | 'days' | 'weeks'; // Unit for maxDelivery
    totalQuantity?: number;   // Total quantity of items
    categoryId?: string;      // Optional category ID
    imageUrl?: string;        // Optional product image URL
    callbackUrl?: string;     // Redirect URL after payment
    customerId: string;       // The BUYER's Payluk customer ID
};

export type CreateEscrowResult = {
    raw: any;
    escrowId: string;         // ID to pass into initEscrowPayment
    paymentToken: string;     // Token for Inline Checkout
    paymentUrl?: string;      // Hosted payment page URL (if provided)
};

export const createEscrow = async (opts: CreateEscrowOpts): Promise<CreateEscrowResult> => {
    const url = `${API_BASE}/v1/escrow/create`;

    const payload = {
        amount: opts.amount,
        purpose: opts.purpose,
        description: opts.description || opts.purpose,
        whoPays: opts.whoPays || 'buyer',
        maxDelivery: opts.maxDelivery ?? 3,
        deliveryTimeline: opts.deliveryTimeline || 'days',
        totalQuantity: opts.totalQuantity ?? 1,
        ...(opts.categoryId && { categoryId: opts.categoryId }),
        ...(opts.imageUrl && { imageUrl: opts.imageUrl }),
        ...(opts.callbackUrl && { callbackUrl: opts.callbackUrl }),
    };

    console.log('🔍 [createEscrow] URL:', url);
    console.log('🔍 [createEscrow] Payload:', payload);

    const resp = await axios.post(url, payload, {
        headers: {
            ...baseHeaders(),
            'customer-id': opts.customerId,   // Required: buyer's customer ID
        },
        timeout: 15_000
    });

    const data = resp.data?.data || resp.data;

    const escrowId = data?.id || data?.escrowId || data?._id;
    const paymentToken = data?.paymentToken || data?.token || data?.payment_token;
    const paymentUrl = data?.paymentUrl || data?.url || data?.payment_url;

    if (!escrowId) {
        console.error('❌ [createEscrow] Could not find escrowId in response:', resp.data);
        throw new Error('Payluk createEscrow did not return an escrowId');
    }
    if (!paymentToken) {
        console.error('❌ [createEscrow] Could not find paymentToken in response:', resp.data);
        throw new Error('Payluk createEscrow did not return a paymentToken');
    }

    return { raw: resp.data, escrowId, paymentToken, paymentUrl };
};

// ─────────────────────────────────────────────
// STEP 2: Buyer pays into the escrow
// POST /v1/payment/escrow
// ─────────────────────────────────────────────
type InitPaymentOpts = {
    amount: number;           // Amount in NGN — must match the escrow amount
    escrowId: string;         // From createEscrow result
    orderId: string;          // Your internal order ID (used as reference)
    customerId: string;       // The BUYER's Payluk customer ID (required header)
    gateway?: 'wallet' | 'card';
    cardId?: string;          // Only required when gateway === 'card'
};

export type InitPaymentResult = {
    raw: any;
    paymentToken?: string;
    paymentUrl?: string;
};

export const initEscrowPayment = async (opts: InitPaymentOpts): Promise<InitPaymentResult> => {
    const url = `${API_BASE}/v1/payment/escrow`;

    const payload: Record<string, any> = {
        amount: opts.amount,
        reference: `order_${opts.orderId}_${Date.now()}`,  // Unique reference
        gateway: opts.gateway || 'card',
        transactionType: 'escrow',
        escrowDetails: {
            escrowId: opts.escrowId,
        },
    };

    // cardId is only sent when paying with a saved card
    if (opts.gateway === 'card' && opts.cardId) {
        payload.cardId = opts.cardId;
    }

    console.log('🔍 [initEscrowPayment] URL:', url);
    console.log('🔍 [initEscrowPayment] Payload:', payload);

    const resp = await axios.post(url, payload, {
        headers: {
            ...baseHeaders(),
            'customer-id': opts.customerId,   // Required header
        },
        timeout: 15_000
    });

    const data = resp.data?.data || resp.data;
    const paymentToken = data?.paymentToken || data?.token || data?.payment_token || data?.reference;
    const paymentUrl = data?.paymentUrl || data?.url || data?.payment_url;

    return { raw: resp.data, paymentToken, paymentUrl };
};

// ─────────────────────────────────────────────
// Verify an escrow payment by paymentToken/ID
// GET /v1/escrow/verify/:paymentId
// ─────────────────────────────────────────────
export const verifyPaymentToken = async (paymentToken: string) => {
    // Note: no /v1 prefix — verify lives at /escrow/verify per the API docs
    const url = `${API_BASE}/v1/escrow/verify/${encodeURIComponent(paymentToken)}`;

    console.log('🔍 [verifyPaymentToken] URL:', url);

    const resp = await axios.get(url, {
        headers: baseHeaders(),
        timeout: 10_000
    });

    const data = resp.data?.data || resp.data;

    return {
        raw: resp.data,
        status: data?.status || resp.data?.status,
        transactionRef: data?.transactionRef || data?.trx_ref || data?.reference,
        amount: data?.amount,
        metadata: data?.metadata || {}
    };
};