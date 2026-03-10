import { Request, Response } from 'express';
import Order from '@/models/order-model';
import Cart from '@/models/cart-model';
import { trackEvent } from '@/services/track-event.service';
import {initEscrowPayment} from "@/services/payluk.service"; // Added import

// Helper to extract User ID from multiple possible middleware formats
const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  console.log(user);
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};


// 1. PLACE ORDER (CHECKOUT)
export const createOrderFromCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const { shippingAddress, paymentMethod } = req.body;

    const cart = await Cart.findOne({ user: userId }).populate('items.product');
    if (!cart || cart.items.length === 0) return res.status(400).json({ message: "Cart is empty" });

    // Assuming first item's business is the target business (or handle multivendor split)
    const firstItem: any = cart.items[0].product;
    const businessId = firstItem.business;

    let totalAmount = 0;
    const orderItems = [];

    // Stock verification and stock reduction
    for (const item of cart.items) {
      const p: any = item.product;
      if (p.stock < item.quantity) {
        return res.status(400).json({ message: `${p.name} is now out of stock` });
      }

      orderItems.push({
        product: p._id,
        name: p.name,
        price: p.price,
        quantity: item.quantity,
        image: p.media?.[0]
      });

      totalAmount += p.price * item.quantity;

      // ATOMIC DECREMENT OF STOCK
      // await Product.findByIdAndUpdate(p._id, { $inc: { stock: -item.quantity } });
    }

    const newOrder = new Order({
      user: userId,
      business: businessId,
      orderNumber: `ORD-${Math.random().toString(36).toUpperCase().substring(2, 9)}`,
      items: orderItems,
      totalAmount,
      shippingAddress,
      paymentMethod,
      status: 'pending',
      paymentStatus: 'pending'
    });

    await newOrder.save();
    await Cart.findOneAndDelete({ user: userId }); // Clear cart after success

    if (!userId || userId === 'null') {
      console.warn('User ID is null or undefined. Payment will be initiated without user context.');
      return res.status(201).json({ message: "Order successful, but user context is missing for payment initiation", order: newOrder });
    }

    // initialize payment with Payluk
    const callbackUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payments/complete`;
    const { paymentToken, paymentUrl, raw } = await initEscrowPayment({
      // amountKobo: Math.round(totalAmount * 100), // convert NGN -> kobo. Confirm with Payluk docs
        amountKobo: totalAmount, // Payluk may expect amount in NGN minor unit (e.g., NGN 100 => 100). Adjust if needed.
      callbackUrl,
      orderId: newOrder._id.toString(),
      userId
    });

    // 🚨 TRACK EVENT: Order Placement
    // We log an activity for the user and (optionally) notify the business
    // 🚨 TRACK EVENT: Order Placement
    await trackEvent({
      // Use 'as any' to bypass the 'unknown' type check for the .toString() call
      targetId: (newOrder._id as any).toString(),
      targetModel: 'Order',
      type: 'ACTIVITY',
      activityData: {
        action: 'ORDER_PLACED',
        description: `You placed order ${newOrder.orderNumber} for NGN ${totalAmount}`,
        metadata: {
          ip: req.ip,
          userAgent: req.headers['user-agent']
        }
      }
    });

    return res.status(201).json({ message: 'Order created. Complete payment with Payluk.', order: newOrder, payluk: {
        paymentToken,
        paymentUrl,
        rawResponse: raw
      } });
  } catch (error) {
    return res.status(500).json({ message: "Order creation failed", error });
  }
};

// 2. GET ORDER HISTORY
export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find({ user: getAuthUserId(req) }).sort({ createdAt: -1 });
    res.status(200).json(orders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch orders", error });
  }
};

// 3. GET SINGLE ORDER DETAIL
export const getOrderById = async (req: Request, res: Response) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Auth check
    if (order.user.toString() !== getAuthUserId(req)) {
      return res.status(403).json({ message: "Unauthorized access" });
    }

    return res.status(200).json(order);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch order", error });
  }
};