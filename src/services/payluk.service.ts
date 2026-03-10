// services/payluk.service.ts
import axios from 'axios';

const API_BASE = process.env.PAYLUK_API_BASE || 'https://staging.api.payluk.ng';
const SECRET = process.env.PAYLUK_SECRET_KEY || '';

if (!SECRET) {
    console.warn('PAYLUK_SECRET_KEY missing. Add to env for Payluk integration.');
}

const headers = {
    Authorization: `Bearer ${SECRET}`,
    'Content-Type': 'application/json'
};

type InitPaymentOpts = {
    amountKobo: number; // NGN minor unit: NGN 100 => 10000 if payluk expects kobo; confirm with dashboard
    currency?: string;
    callbackUrl: string;
    orderId: string; // your internal order id
    userId?: string;
    email?: string;
    username?: string;
    description?: string;
    metadata?: Record<string, any>;
    gateway?: 'card'
    escrowId: string; // required for escrow payments
    cardId?: string; // optional if you want to charge a saved card
};

export const initEscrowPayment = async (opts: InitPaymentOpts) => {
    const payload = {
        amount: opts.amountKobo,
        currency: opts.currency || "NGN",
        reference: `order_${opts.orderId}`,
        gateway: opts.gateway || 'card',
        transactionType: 'escrow',
        escrowDetails: {
            escrowId: opts.escrowId
        },
        cardId: opts.cardId,
        callback_url: opts.callbackUrl,
        description: opts.description || `Payment for Order ${opts.orderId}`,
        metadata: {
            orderId: opts.orderId,
            userId: opts.userId,
            ...opts.metadata
        }
    };

    const url = `${API_BASE}/v1/payment/escrow`;

    // Log the exact URL so you can verify it against Payluk docs and dashboard. Also log payload and headers for debugging.
    console.log('🔍 Payluk URL:', url);
    console.log('🔍 Payluk Payload:', payload);
    console.log('🔍 Payluk Headers:', headers);


    const resp = await axios.post(url, payload, { headers, timeout: 15_000 });

    // payluk responses vary; data usually under resp.data.data
    const data = resp.data?.data || resp.data;
    // try common keys
    const paymentToken = data?.paymentToken || data?.token || data?.payment_token || data?.reference;
    const paymentUrl = data?.paymentUrl || data?.url || data?.payment_url;

    return {
        raw: resp.data,
        paymentToken,
        paymentUrl
    };
};

export const verifyPaymentToken = async (paymentToken: string) => {
    const url = `${API_BASE}/v1/escrow/verify/${encodeURIComponent(paymentToken)}`;
    const resp = await axios.get(url, { headers, timeout: 10_000 });

    const data = resp.data?.data || resp.data;
    return {
        raw: resp.data,
        status: data?.status || resp.data?.status,
        transactionRef: data?.transactionRef || data?.trx_ref || data?.reference,
        amount: data?.amount,
        metadata: data?.metadata || {}
    };
};