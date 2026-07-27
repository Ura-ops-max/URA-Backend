import mongoose from 'mongoose';
import Order, { OrderStatus } from '@/models/order-model';
import Cart from '@/models/cart-model';
import { Product } from '@/models/product-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { createPaymentLink, createPaylukCustomer } from '@/services/payluk.service';

export interface ShippingAddress {
  fullAddress: string;
  city: string;
  /** Destination state — what the Fez delivery quote is priced on. */
  state?: string;
  phone: string;
}

export interface CheckoutResult {
  order: { _id: unknown; orderNumber: string; totalAmount: number; status: string };
  payluk: { paymentToken: string; escrowId: string | null; customerId: string; fee: number; payableAmount: number };
}

export async function checkoutFromCart(
  userId: string,
  shippingAddress: ShippingAddress,
  paymentMethod = 'card',
  ip?: string,
  userAgent?: string,
  delivery?: { deliveryFee?: number; deliveryMethod?: 'delivery' | 'pickup' },
): Promise<CheckoutResult> {
  // Shipping is only charged on the delivery option; direct payment sends 0.
  const deliveryFee = Math.max(0, Number(delivery?.deliveryFee) || 0);
  const deliveryMethod = delivery?.deliveryMethod === 'delivery' ? 'delivery' : 'pickup';
  const buyer = await User.findById(userId);
  if (!buyer?.paylukCustomerId) {
    const err: any = new Error('Payment profile required');
    err.code = 'PAYLUK_PROFILE_REQUIRED';
    err.status = 422;
    throw err;
  }

  const cart = await Cart.findOne({ user: userId }).populate('items.product');
  if (!cart || cart.items.length === 0) {
    const err: any = new Error('Cart is empty');
    err.status = 400;
    throw err;
  }

  let totalAmount = 0;
  const orderItems = [];

  for (const item of cart.items) {
    const p: any = item.product;
    if (!p) continue;
    if (p.stock < item.quantity) {
      const err: any = new Error(`"${p.name}" only has ${p.stock} unit(s) left in stock`);
      err.status = 400;
      throw err;
    }
    orderItems.push({ product: p._id, name: p.name, price: p.price, quantity: item.quantity, image: p.media?.[0] ?? null });
    totalAmount += p.price * item.quantity;
  }

  const firstProduct: any = cart.items[0].product;

  // What the buyer actually pays: items subtotal + shipping (0 for pickup).
  const grandTotal = totalAmount + deliveryFee;

  // Find the seller (product's business owner). They need a Payluk customer id
  // to receive escrow funds. If they never onboarded, auto-create one on the fly
  // so an un-onboarded seller doesn't block the buyer from checking out.
  const sellerBusiness = await Business.findById(firstProduct.business).lean();
  const seller = sellerBusiness
    ? await User.findById((sellerBusiness as any).owner)
    : null;

  if (!seller) {
    const err: any = new Error('This product is not available for purchase yet.');
    err.code = 'PRODUCT_NOT_AVAILABLE';
    err.status = 422;
    throw err;
  }

  let sellerCustomerId = seller.paylukCustomerId;
  if (!sellerCustomerId) {
    try {
      const created = await createPaylukCustomer({
        firstName: seller.firstName || (sellerBusiness as any)?.businessName || 'Seller',
        lastName: seller.lastName || 'Merchant',
        email: seller.email,
        phone: (seller as any).phone,
      });
      sellerCustomerId = created.customerId;
      await User.updateOne({ _id: seller._id }, { $set: { paylukCustomerId: sellerCustomerId } });
      console.log(`✅ [checkout] auto-created Payluk customer for seller ${seller._id}`);
    } catch (e) {
      console.error('[checkout] seller Payluk customer creation failed:', (e as Error).message);
      const err: any = new Error('This product is not available for purchase yet.');
      err.code = 'PRODUCT_NOT_AVAILABLE';
      err.status = 422;
      throw err;
    }
  }

  // Create a fresh escrow for this specific order — Payluk escrows are single-use per payment
  const escrow = await createPaymentLink({
    amount:           grandTotal,
    purpose:          firstProduct.name,
    description:      firstProduct.description || firstProduct.name,
    whoPays:          firstProduct.whoPays || 'buyer',
    maxDelivery:      firstProduct.maxDelivery ?? 3,
    deliveryTimeline: firstProduct.deliveryTimeline || 'days',
    totalQuantity:    cart.items.reduce((sum: number, i: any) => sum + i.quantity, 0),
    imageUrl:         firstProduct.media?.[0] ?? null,
    customerId:       sellerCustomerId!,
  });

  const paylukPaymentToken = escrow.paymentToken;
  const paylukEscrowId     = escrow.escrowId;

  const order = await Order.create({
    user: userId,
    business: firstProduct.business,
    orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
    items: orderItems,
    // totalAmount is what the buyer is charged (items + shipping).
    totalAmount: grandTotal,
    deliveryFee,
    deliveryMethod,
    shippingAddress,
    paymentMethod,
    status: 'pending',
    paymentStatus: 'pending',
    paylukPaymentToken,
    paylukEscrowId,
    payment: { provider: 'payluk' },
  });

  trackEvent({
    targetId: (order._id as any).toString(),
    targetModel: 'Order',
    type: 'ACTIVITY',
    activityData: {
      action: 'ORDER_PLACED',
      description: `Order ${order.orderNumber} placed — NGN ${grandTotal}`,
      metadata: { ip, userAgent },
    },
  }).catch(() => {});

  return {
    order: { _id: order._id, orderNumber: order.orderNumber, totalAmount: order.totalAmount, status: order.status },
    payluk: { paymentToken: paylukPaymentToken, escrowId: paylukEscrowId, customerId: buyer.paylukCustomerId!, fee: escrow.fee, payableAmount: escrow.payableAmount },
  };
}

export async function confirmPayment(
  userId: string,
  paymentId: string,
): Promise<{ alreadyConfirmed: boolean; order: Record<string, unknown> }> {
  const pending = await Order.findOne({ user: userId, paymentStatus: 'pending' })
    .sort({ createdAt: -1 })
    .populate('items.product');

  if (!pending) {
    const paid = await Order.findOne({ user: userId, paymentStatus: 'paid' }).sort({ createdAt: -1 });
    if (paid) {
      return {
        alreadyConfirmed: true,
        order: { _id: paid._id, orderNumber: paid.orderNumber, totalAmount: paid.totalAmount, status: paid.status, paymentStatus: paid.paymentStatus },
      };
    }
    const err: any = new Error('No pending order found');
    err.status = 404;
    throw err;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of pending.items as any[]) {
        const productId = item.product?._id ?? item.product;
        const product = await Product.findById(productId).session(session);
        if (product && product.stock >= item.quantity) {
          await Product.findByIdAndUpdate(productId, { $inc: { stock: -item.quantity } }, { session });
        }
      }
      pending.paymentStatus = 'paid';
      pending.status = OrderStatus.PROCESSING;
      pending.paidAt = new Date();
      pending.payment = { provider: 'payluk', transactionRef: paymentId };
      await pending.save({ session });
      await Cart.findOneAndDelete({ user: userId }, { session });
    });
  } finally {
    await session.endSession();
  }

  trackEvent({
    targetId: (pending._id as any).toString(),
    targetModel: 'Order',
    type: 'BOTH',
    notificationData: {
      type: 'ORDER',
      title: 'Payment Confirmed!',
      message: `Your order ${pending.orderNumber} has been confirmed.`,
      sender: userId,
      senderModel: 'User',
      relatedId: (pending._id as any).toString(),
      modelType: 'Order',
    },
    activityData: { action: 'ORDER_PAID', description: `Payment confirmed for order ${pending.orderNumber} — ref: ${paymentId}` },
  }).catch(() => {});

  return {
    alreadyConfirmed: false,
    order: { _id: pending._id, orderNumber: pending.orderNumber, totalAmount: pending.totalAmount, status: pending.status, paymentStatus: pending.paymentStatus },
  };
}

export const getOrdersForUser = (userId: string) =>
  Order.find({ user: userId }).sort({ createdAt: -1 }).populate('items.product', 'name media price');

export const getOrderByIdForUser = async (orderId: string, userId: string) => {
  const order = await Order.findById(orderId).populate('items.product', 'name media price');
  if (!order) { const e: any = new Error('Order not found'); e.status = 404; throw e; }
  if (order.user.toString() !== userId) { const e: any = new Error('Unauthorized'); e.status = 403; throw e; }
  return order;
};
