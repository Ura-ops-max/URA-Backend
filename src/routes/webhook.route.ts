// routes/webhook.route.ts
import express from 'express';
import { raw } from 'body-parser';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import { verifyPaymentToken } from '@/services/payluk.service';
import Order, {OrderStatus} from '@/models/order-model';
import { trackEvent } from '@/services/track-event.service';
import {Product} from "@/models/product-model";

const router = express.Router();

// Use raw body parser only for webhook route so we can validate signature
router.post('/payluk', raw({ type: 'application/json' }), async (req, res) => {
    try {
        // raw buffer
        const rawBody = (req as any).body as Buffer;
        // If body-parser raw didn't give buffer, fallback to raw-body
        const buf = Buffer.isBuffer(rawBody) ? rawBody : await getRawBody(req);

        const signatureHeader =
            (req.headers['x-payluk-signature'] as string) ||
            (req.headers['x-signature'] as string) ||
            (req.headers['x-hub-signature'] as string) ||
            '';

        const webhookSecret = process.env.PAYLUK_WEBHOOK_SECRET || '';
        if (webhookSecret) {
            const hmac = crypto.createHmac('sha512', webhookSecret).update(buf).digest('hex');

            if (!signatureHeader || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signatureHeader))) {
                console.warn('Invalid Payluk webhook signature');
                return res.status(401).send({ ok: false, message: 'Invalid signature' });
            }
        } else {
            console.warn('PAYLUK_WEBHOOK_SECRET not configured. Webhook signature not validated.');
            // Optional: return 500 to force you to configure secret
        }

        const payload = JSON.parse(buf.toString('utf8'));
        // common fields: payload.data.token or payload.data.payment_token or payload.paymentToken
        const paymentToken =
            payload?.data?.paymentToken ||
            payload?.data?.token ||
            payload?.data?.payment_token ||
            payload?.paymentToken ||
            payload?.token ||
            payload?.reference;

        if (!paymentToken) {
            console.warn('Webhook without payment token', payload);
            return res.status(400).send({ ok: false, message: 'No payment token' });
        }

        // verify with Payluk to be safe
        const verifyResp = await verifyPaymentToken(paymentToken);
        const { status, metadata, transactionRef } = verifyResp;

        // typical status: "success", "paid", etc. Adjust match to Payluk values.
        const isPaid = status === 'success' || status === 'paid' || status === 'completed';

        // metadata should contain orderId if we included it while creating
        const orderId = metadata?.orderId || (payload?.data?.metadata?.orderId) || (payload?.metadata?.orderId);

        if (!orderId) {
            console.warn('Webhook missing orderId in metadata', payload);
            // still respond 200 so Payluk stops retrying, but consider manual reconciliation
            return res.status(200).send({ ok: true, message: 'No orderId attached' });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            console.warn('Order not found for webhook orderId', orderId);
            return res.status(404).send({ ok: false, message: 'Order not found' });
        }

        if (isPaid) {
            if (order.paymentStatus === 'paid') {
                // idempotent
                return res.status(200).send({ ok: true, message: 'Already marked paid' });
            }

            // 🔹 Deduct stock now that payment is confirmed
            for (const item of order.items) {
                const p: any = item.product;
                if (p.stock < item.quantity) {
                    console.warn(`Product ${p.name} out of stock during webhook processing`);
                    // Optionally: mark order as failed or notify admin
                    return res.status(400).send({ ok: false, message: `${p.name} out of stock` });
                }
                await Product.findByIdAndUpdate(p._id, { $inc: { stock: -item.quantity } });
            }

            order.paymentStatus = 'paid';
            order.status = OrderStatus.PROCESSING;
            order.payment = {
                provider: 'payluk',
                transactionRef: transactionRef || paymentToken,
                details: verifyResp.raw
            };
            order.paidAt = new Date();
            await order.save();

            // track event & notification
            await trackEvent({
                targetId: order._id.toString(),
                targetModel: 'Order',
                type: 'BOTH',
                activityData: {
                    action: 'ORDER_PAID',
                    description: `Order ${order.orderNumber} marked paid via Payluk`,
                    metadata: { transactionRef }
                },
                notificationData: {
                    type: 'BUSINESS',
                    title: 'New Order Paid',
                    message: `Order ${order.orderNumber} has been paid.`,
                    sender: 'system',
                    senderModel: 'User',
                    relatedId: order._id.toString(),
                    modelType: 'Order'
                }
            });

            return res.status(200).send({ ok: true });
        } else {
            // not paid; Payluk might send failure, pending updates
            order.payment = {
                provider: 'payluk',
                transactionRef: transactionRef || paymentToken,
                details: verifyResp.raw
            };
            order.paymentStatus = 'failed';
            await order.save();

            return res.status(200).send({ ok: true });
        }
    } catch (err) {
        console.error('payluk webhook error', err);
        // respond 200 to avoid infinite retries only if you want that behavior.
        // Recommended: respond 500 so Payluk will retry (and you can inspect errors)
        return res.status(500).send({ ok: false, message: 'server error' });
    }
});

export default router;