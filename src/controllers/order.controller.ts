import { Request, Response } from 'express';
import Order from '@/models/order-model';
import Cart from '@/models/cart-model';
import { User } from '@/models/user-model';
import { trackEvent } from '@/services/track-event.service';
import { createPaylukCustomer } from '@/services/payluk.service';

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};
// ─────────────────────────────────────────────
// 1. PLACE ORDER (CHECKOUT)
// POST /order/checkout
// ─────────────────────────────────────────────
export const createOrderFromCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const { shippingAddress, paymentMethod } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!shippingAddress?.fullAddress || !shippingAddress?.city || !shippingAddress?.phone) {
      return res.status(400).json({ message: 'Complete shipping address is required' });
    }

    const cart = await Cart.findOne({ user: userId }).populate('items.product');
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    // Stock check only — never deduct here.
    // Deduction happens in the webhook after confirmed payment.
    let totalAmount = 0;
    const orderItems = [];

    for (const item of cart.items) {
      const p: any = item.product;
      if (!p) continue;

      if (p.stock < item.quantity) {
        return res.status(400).json({
          message: `"${p.name}" only has ${p.stock} unit(s) left in stock`,
        });
      }

      orderItems.push({
        product: p._id,
        name: p.name,
        price: p.price,
        quantity: item.quantity,
        image: p.media?.[0] ?? null,
      });

      totalAmount += p.price * item.quantity;
    }

    const firstProduct: any = cart.items[0].product;
    const paylukPaymentToken: string | null = firstProduct.paylukPaymentToken ?? null;
    const paylukEscrowId: string | null = firstProduct.paylukEscrowId ?? null;

    if (!paylukPaymentToken) {
      return res.status(422).json({
        code: 'PAYLUK_SETUP_REQUIRED',
        message: 'This product is not available for purchase yet.',
      });
    }

    const buyer = await User.findById(userId).select('+paylukCustomerId');
    const buyerPaylukCustomerId: string | null = buyer?.paylukCustomerId ?? null;

    const existingPendingOrder = await Order.findOne({
      user: userId,
      paymentStatus: 'pending',
      'items.product': firstProduct._id,
    });

    let newOrder;
    if (existingPendingOrder) {
      // Reuse the existing pending order — just return the token again
      newOrder = existingPendingOrder;
    } else {
      newOrder = await Order.create({
        user: userId,
        business: firstProduct.business,
        orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
        items: orderItems,
        totalAmount,
        shippingAddress,
        paymentMethod: paymentMethod ?? 'card',
        status: 'pending',
        paymentStatus: 'pending',
        payment: { provider: 'payluk' },
      });

      await trackEvent({
        targetId: (newOrder._id as any).toString(),
        targetModel: 'Order',
        type: 'ACTIVITY',
        activityData: {
          action: 'ORDER_PLACED',
          description: `Order ${newOrder.orderNumber} placed — NGN ${totalAmount}`,
          metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
        },
      });
    }

    // ⚠️  Cart is NOT deleted here.
    // It is deleted in the Payluk webhook once payment is confirmed.
    // This ensures the cart survives widget close / payment failure.

    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: {
        _id: newOrder._id,
        orderNumber: newOrder.orderNumber,
        totalAmount: newOrder.totalAmount,
        status: newOrder.status,
      },
      payluk: {
        paymentToken: paylukPaymentToken,
        escrowId: paylukEscrowId,
        customerId: buyerPaylukCustomerId,
      },
    });

  } catch (error: any) {
    console.error('❌ [createOrderFromCart]:', error?.message || error);
    return res.status(500).json({
      message: 'Order creation failed',
      error: error?.message,
    });
  }
};


// ─────────────────────────────────────────────
// CONFIRM PAYMENT (client-side fallback)
// POST /order/confirm
// Called by the /payments/complete page with the paymentId from Payluk.
// The webhook is the canonical source of truth — this is the fallback
// in case the webhook hasn't fired yet when the user lands on the page.
// ─────────────────────────────────────────────
export const confirmOrderPayment = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ message: 'paymentId is required' });
    }

    // Find the most recent pending order for this buyer
    const order = await Order.findOne({
      user: userId,
      paymentStatus: 'pending',
    })
        .sort({ createdAt: -1 })
        .populate('items.product');

    if (!order) {
      // Webhook may have already confirmed it — look for a paid order instead
      const paidOrder = await Order.findOne({ user: userId, paymentStatus: 'paid' })
          .sort({ createdAt: -1 });

      if (paidOrder) {
        return res.status(200).json({
          success: true,
          alreadyConfirmed: true,
          order: {
            _id: paidOrder._id,
            orderNumber: paidOrder.orderNumber,
            totalAmount: paidOrder.totalAmount,
            status: paidOrder.status,
            paymentStatus: paidOrder.paymentStatus,
          },
        });
      }

      return res.status(404).json({ message: 'No pending order found' });
    }

    // Mark as paid
    order.paymentStatus = 'paid';
    order.status = 'processing';
    order.paidAt = new Date();
    order.payment = {
      provider: 'payluk',
      transactionRef: paymentId,
    };
    await order.save();

    // Deduct stock per item — only now, after payment confirmed
    for (const item of order.items as any[]) {
      await Product.findByIdAndUpdate(item.product._id ?? item.product, {
        $inc: { stock: -item.quantity },
      });
    }

    // Clear the buyer's cart
    await Cart.findOneAndDelete({ user: userId });

    await trackEvent({
      targetId: (order._id as any).toString(),
      targetModel: 'Order',
      type: 'BOTH',
      notificationData: {
        type: 'ORDER',
        title: 'Payment Confirmed!',
        message: `Your order ${order.orderNumber} has been confirmed and is being processed.`,
        sender: userId,
        senderModel: 'User',
        relatedId: (order._id as any).toString(),
        modelType: 'Order',
      },
      activityData: {
        action: 'ORDER_PAID',
        description: `Payment confirmed for order ${order.orderNumber} — ref: ${paymentId}`,
      },
    });

    return res.status(200).json({
      success: true,
      order: {
        _id: order._id,
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        status: order.status,
        paymentStatus: order.paymentStatus,
      },
    });

  } catch (error: any) {
    console.error('❌ [confirmOrderPayment]:', error?.message || error);
    return res.status(500).json({ message: 'Failed to confirm payment', error: error?.message });
  }
};

// ─────────────────────────────────────────────
// 2. GET ORDER HISTORY
// ─────────────────────────────────────────────
export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find({ user: getAuthUserId(req) })
        .sort({ createdAt: -1 })
        .populate('items.product', 'name media price');
    return res.status(200).json({ success: true, orders });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch orders', error });
  }
};

// ─────────────────────────────────────────────
// 3. GET SINGLE ORDER
// ─────────────────────────────────────────────
export const getOrderById = async (req: Request, res: Response) => {
  try {
    const order = await Order.findById(req.params.id)
        .populate('items.product', 'name media price');

    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.user.toString() !== getAuthUserId(req)) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch order', error });
  }
};

// ─────────────────────────────────────────────
// 4. SETUP PAYLUK CUSTOMER (for buyers)
// POST /order/setup-payment-profile
// ─────────────────────────────────────────────
export const setupPaylukCustomer = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const dbUser = await User.findById(userId).select('+bvn +paylukCustomerId');
    if (!dbUser) return res.status(404).json({ message: 'User not found' });

    // Idempotent — never create twice
    if (dbUser.paylukCustomerId) {
      return res.status(200).json({
        message: 'Payment profile already set up',
        paylukCustomerId: dbUser.paylukCustomerId,
      });
    }

    const { phone, bvn } = req.body;
    if (!phone || !bvn) {
      return res.status(400).json({ message: 'Phone and BVN are required' });
    }

    dbUser.phone = phone;
    dbUser.bvn = bvn;
    await dbUser.save();

    const result = await createPaylukCustomer({
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      email: dbUser.email,
      phone,
      bvn,
    });

    dbUser.paylukCustomerId = result.customerId;
    await dbUser.save();

    return res.status(201).json({
      message: 'Payment profile created successfully',
      paylukCustomerId: result.customerId,
    });
  } catch (error: any) {
    console.error('❌ [setupPaylukCustomer]:', error?.response?.data || error);
    return res.status(500).json({
      message: 'Failed to set up payment profile',
      error: error?.message,
    });
  }
};