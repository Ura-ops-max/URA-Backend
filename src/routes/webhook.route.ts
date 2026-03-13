import express from 'express';
import { raw } from 'body-parser';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import { verifyPaymentToken } from '@/services/payluk.service';
import Order, { OrderStatus } from '@/models/order-model';
import { trackEvent } from '@/services/track-event.service';
import { Product } from '@/models/product-model';

const router = express.Router();

router.post('/payluk', raw({ type: 'application/json' }), async (req, res) => {
    try {
        const rawBody = (req as any).body as Buffer;
        const buf = Buffer.isBuffer(rawBody) ? rawBody : await getRawBody(req);

        const signatureHeader =
            (req.headers['x-payluk-signature'] as string) ||
            (req.headers['x-signature'] as string) ||
            '';

        const webhookSecret = process.env.PAYLUK_WEBHOOK_SECRET || '';

        if (!webhookSecret) {
            console.error('❌ PAYLUK_WEBHOOK_SECRET is not set. Rejecting webhook.');
            return res.status(500).send({ ok: false, message: 'Webhook secret not configured' });
        }

        // ✅ Fixed: sha512 per Payluk docs (was sha256)
        const hmac = crypto.createHmac('sha512', webhookSecret).update(buf).digest('hex');

        if (!signatureHeader) {
            console.warn('Webhook received with no signature header');
            return res.status(401).send({ ok: false, message: 'Missing signature' });
        }

        // Pad buffers to equal length to prevent timing attacks
        const sigBuf = Buffer.from(signatureHeader.padEnd(hmac.length, '0'));
        const hmacBuf = Buffer.from(hmac.padEnd(signatureHeader.length, '0'));

        if (sigBuf.length !== hmacBuf.length || !crypto.timingSafeEqual(hmacBuf, sigBuf)) {
            console.warn('Invalid Payluk webhook signature');
            return res.status(401).send({ ok: false, message: 'Invalid signature' });
        }

        const payload = JSON.parse(buf.toString('utf8'));

        const paymentToken =
            payload?.data?.paymentToken ||
            payload?.data?.token ||
            payload?.data?.payment_token ||
            payload?.paymentToken ||
            payload?.token ||
            payload?.reference;

        if (!paymentToken) {
            console.warn('Webhook missing paymentToken', payload);
            return res.status(400).send({ ok: false, message: 'No payment token' });
        }

        const verifyResp = await verifyPaymentToken(paymentToken);
        const { status, metadata, transactionRef } = verifyResp;

        const isPaid = status === 'success' || status === 'paid' || status === 'completed' || status === 'ONGOING';

        const orderId =
            metadata?.orderId ||
            payload?.data?.metadata?.orderId ||
            payload?.metadata?.orderId;

        if (!orderId) {
            console.warn('Webhook missing orderId in metadata', payload);
            return res.status(200).send({ ok: true, message: 'No orderId in metadata — manual reconciliation needed' });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            console.warn('Order not found for orderId', orderId);
            return res.status(404).send({ ok: false, message: 'Order not found' });
        }

        if (isPaid) {
            // Idempotency guard
            if (order.paymentStatus === 'paid') {
                return res.status(200).send({ ok: true, message: 'Already marked paid' });
            }

            // Deduct stock now that payment is confirmed
            for (const item of order.items) {
                const p: any = item.product;
                if (p.stock < item.quantity) {
                    console.warn(`Product ${p.name} out of stock during webhook processing`);
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
        return res.status(500).send({ ok: false, message: 'server error' });
    }
});

export default router;