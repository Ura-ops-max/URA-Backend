import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Order, { OrderStatus } from '@/models/order-model';
import Cart from '@/models/cart-model';
import { Product } from '@/models/product-model';
import { trackEvent } from '@/services/track-event.service';

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
// Handler: escrow.ongoing — buyer payment confirmed, money held in escrow
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

  // Idempotency guard
  if (order.paymentStatus === 'paid') {
    console.log('[webhook] Order already marked paid — skipping');
    return;
  }

  const transactionRef: string =
    data?.paymentDetails?.reference ||
    data?.reference ||
    paymentToken;

  // Atomic: deduct stock + mark paid + clear cart
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of order.items) {
        const product = await Product.findById(item.product).session(session);
        if (!product) {
          console.warn(`[webhook] Product for item "${item.name}" not found — skipping stock`);
          continue;
        }
        if (product.stock < item.quantity) {
          throw new Error(`"${product.name}" is out of stock`);
        }
        await Product.findByIdAndUpdate(
          item.product,
          { $inc: { stock: -item.quantity } },
          { session }
        );
      }

      order.paymentStatus = 'paid';
      order.status = OrderStatus.PROCESSING;
      order.paidAt = new Date();
      order.payment = {
        provider: 'payluk',
        transactionRef,
        details: data,
      };
      await order.save({ session });

      await Cart.findOneAndDelete({ user: order.user }, { session });
    });
  } finally {
    await session.endSession();
  }

  trackEvent({
    targetId: order._id.toString(),
    targetModel: 'Order',
    type: 'BOTH',
    activityData: {
      action: 'ORDER_PAID',
      description: `Order ${order.orderNumber} payment received via Payluk`,
      metadata: { transactionRef },
    },
    notificationData: {
      type: 'BUSINESS',
      title: 'Payment Received',
      message: `Order ${order.orderNumber} has been paid and is being processed.`,
      sender: 'system',
      senderModel: 'User',
      relatedId: order._id.toString(),
      modelType: 'Order',
    },
  }).catch(e => console.error('[webhook] trackEvent failed:', e));
}

// ---------------------------------------------------------------------------
// Handler: escrow.completed — buyer confirmed delivery, funds released to seller
// ---------------------------------------------------------------------------
async function handleEscrowCompleted(data: Record<string, any>) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const order = await Order.findOne({ paylukPaymentToken: paymentToken });
  if (!order || order.status === OrderStatus.DELIVERED) return;

  order.status = OrderStatus.DELIVERED;
  await order.save();

  trackEvent({
    targetId: order._id.toString(),
    targetModel: 'Order',
    type: 'BOTH',
    activityData: {
      action: 'ORDER_DELIVERED',
      description: `Order ${order.orderNumber} funds released to seller`,
    },
    notificationData: {
      type: 'BUSINESS',
      title: 'Order Completed',
      message: `Order ${order.orderNumber} has been completed and funds released.`,
      sender: 'system',
      senderModel: 'User',
      relatedId: order._id.toString(),
      modelType: 'Order',
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Handler: escrow.refunded
// ---------------------------------------------------------------------------
async function handleEscrowRefunded(data: Record<string, any>) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const order = await Order.findOne({ paylukPaymentToken: paymentToken });
  if (!order) return;

  order.status = OrderStatus.REFUNDED;
  order.paymentStatus = 'failed';
  await order.save();

  // Re-stock items
  for (const item of order.items) {
    await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.quantity } });
  }

  trackEvent({
    targetId: order._id.toString(),
    targetModel: 'Order',
    type: 'BOTH',
    activityData: {
      action: 'ORDER_REFUNDED',
      description: `Order ${order.orderNumber} refunded`,
    },
    notificationData: {
      type: 'BUSINESS',
      title: 'Order Refunded',
      message: `Order ${order.orderNumber} has been refunded.`,
      sender: 'system',
      senderModel: 'User',
      relatedId: order._id.toString(),
      modelType: 'Order',
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Handler: escrow.disputed / escrow.investigating
// ---------------------------------------------------------------------------
async function handleEscrowDisputed(data: Record<string, any>, event: string) {
  const paymentToken: string | undefined = data?.paymentToken || data?.token;
  if (!paymentToken) return;

  const order = await Order.findOne({ paylukPaymentToken: paymentToken });
  if (!order) return;

  trackEvent({
    targetId: order._id.toString(),
    targetModel: 'Order',
    type: 'BOTH',
    activityData: {
      action: event === 'escrow.disputed' ? 'ORDER_DISPUTED' : 'ORDER_INVESTIGATING',
      description: `Order ${order.orderNumber} — ${event}`,
    },
    notificationData: {
      type: 'BUSINESS',
      title: event === 'escrow.disputed' ? 'Dispute Opened' : 'Dispute Under Review',
      message: `A dispute has been ${event === 'escrow.disputed' ? 'opened' : 'escalated'} for order ${order.orderNumber}.`,
      sender: 'system',
      senderModel: 'User',
      relatedId: order._id.toString(),
      modelType: 'Order',
    },
  }).catch(() => {});
}

export default router;
