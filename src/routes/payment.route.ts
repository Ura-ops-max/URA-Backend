import express from 'express';
import { initEscrowPayment } from '@/services/payluk.service';
import Order from '@/models/order-model';

const router = express.Router();

router.post('/init', async (req, res) => {
    try {
        const { orderId } = req.body;

        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const payment = await initEscrowPayment({
            amountKobo: order.totalAmount * 100,
            callbackUrl: `${process.env.APP_URL}/payment-success`,
            orderId: order._id.toString(),
            userId: order.user.toString(),
            metadata: {
                orderNumber: order.orderNumber
            }
        });

        return res.json({
            paymentUrl: payment.paymentUrl,
            paymentToken: payment.paymentToken
        });

    } catch (err: any) {
        console.error("Checkout error:", err?.response?.data || err);

        return res.status(500).json({
            success: false,
            message: "Order creation failed",
            error: err?.response?.data || err.message,
        });
    }
});

export default router;