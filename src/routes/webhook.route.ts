import express from 'express';
import crypto from 'crypto';
import Order, { OrderStatus } from '@/models/order-model';
import { Product } from '@/models/product-model';
import { markOrderPaid, notifyOrderEvent } from '@/services/order-events.service';

const router = express.Router();

// ---------------------------------------------------------------------------
// Payluk signs the payload using:
//   HMAC-SHA512(JSON.stringify(req.body), secretKey)
// The result is compared with req.headers['x-payluk-signature'] as a hex string.
// ---------------------------------------------------------------------------
function verifySignature(body: unknown, signatureHeader: string): boolean {
  const secret = process.env.PAYLUK_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] PAYLUK_WEBHOOK_SECRET is not configured');
    return false;
  }
  const computed = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
}

// ---------------------------------------------------------------------------
// POST /payluk  (mounted at /api/v1/webhooks/payluk in routes/index.ts)
// This route relies on express.json() having already parsed the body.
// ---------------------------------------------------------------------------
router.post('/payluk', async (req, res) => {
  if (!process.env.PAYLUK_WEBHOOK_SECRET) {
    console.error('[webhook] PAYLUK_WEBHOOK_SECRET not set — rejecting');
    return res.status(500).json({ ok: false, message: 'Webhook secret not configured' });
  }

  const signatureHeader = (req.headers['x-payluk-signature'] as string) || '';
  if (!signatureHeader) {
    console.warn('[webhook] Missing x-payluk-signature header');
    return res.status(401).json({ ok: false, message: 'Missing signature' });
  }

  // Both buffers must be the same length for timingSafeEqual
  if (signatureHeader.length !== 128) { // sha512 hex is always 128 chars
    console.warn('[webhook] Malformed signature header (wrong length)');
    return res.status(401).json({ ok: false, message: 'Invalid signature' });
  }

  if (!verifySignature(req.body, signatureHeader)) {
    console.warn('[webhook] Invalid Payluk signature');
    return res.status(401).json({ ok: false, message: 'Invalid signature' });
  }

  const payload = req.body;
  const event: string = payload?.event || '';
  const data = payload?.data || {};

  // ── Event routing ─────────────────────────────────────────────────────────
  try {
    switch (event) {
      case 'escrow.ongoing':
        // Buyer payment received — money is in escrow
        await handlePaymentReceived(data);
        break;

      case 'escrow.completed':
        // Funds released to seller — buyer confirmed delivery (or auto-released)
        await handleEscrowCompleted(data);
        break;

      case 'escrow.refunded':
        await handleEscrowRefunded(data);
        break;

      case 'escrow.disputed':
      case 'escrow.investigating':
        await handleEscrowDisputed(data, event);
        break;

      case 'escrow.created':
        // Nothing to do on our side — order already created before payment
        break;

      default:
        console.log(`[webhook] Unhandled event: "${event}" — acknowledged`);
    }
  } catch (err: any) {
    console.error(`[webhook] Error handling event "${event}":`, err?.message || err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }

  // Always return 200 so Payluk does not retry
  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Handler: escrow.ongoing — buyer payment confirmed, money held in escrow.
// markOrderPaid is atomic + idempotent and notifies buyer and seller.
// ---------------------------------------------------------------------------
async function handlePaymentReceived(data: Record<string, any>) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) {
    console.warn('[webhook] escrow.ongoing missing paymentToken');
    return;
  }

  const order = await Order.findOne({ paylukPaymentToken: paymentToken }).sort({ createdAt: -1 });
  if (!order) {
    console.warn('[webhook] Order not found for paymentToken:', paymentToken);
    return;
  }

  const transactionRef: string =
    data?.paymentDetails?.reference || data?.reference || paymentToken;

  const updated = await markOrderPaid(order._id, transactionRef, data);
  if (!updated) console.log('[webhook] Order already marked paid — skipping');
}

// ---------------------------------------------------------------------------
// Handler: escrow.completed — buyer confirmed receipt, funds released to seller
// ---------------------------------------------------------------------------
async function handleEscrowCompleted(data: Record<string, any>) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const order = await Order.findOneAndUpdate(
    { paylukPaymentToken: paymentToken, status: { $ne: OrderStatus.DELIVERED } },
    { $set: { status: OrderStatus.DELIVERED } },
    { new: true },
  );
  if (!order) return;
  notifyOrderEvent(order, 'DELIVERED').catch(() => {});
}

// ---------------------------------------------------------------------------
// Handler: escrow.refunded — only restock if stock was actually taken (paid)
// ---------------------------------------------------------------------------
async function handleEscrowRefunded(data: Record<string, any>) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const before = await Order.findOneAndUpdate(
    { paylukPaymentToken: paymentToken, status: { $ne: OrderStatus.REFUNDED } },
    { $set: { status: OrderStatus.REFUNDED, paymentStatus: 'failed' } },
  ); // returns the order as it was BEFORE this update
  if (!before) return;

  if (before.paymentStatus === 'paid') {
    for (const item of before.items) {
      await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.quantity } });
    }
  }
  const order = await Order.findById(before._id);
  if (order) notifyOrderEvent(order, 'REFUNDED').catch(() => {});
}

// ---------------------------------------------------------------------------
// Handler: escrow.disputed / escrow.investigating
// ---------------------------------------------------------------------------
async function handleEscrowDisputed(data: Record<string, any>, event: string) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const order = await Order.findOne({ paylukPaymentToken: paymentToken });
  if (!order) return;
  console.log(`[webhook] ${event} for order ${order.orderNumber}`);
  notifyOrderEvent(order, 'DISPUTED').catch(() => {});
}

export default router;
