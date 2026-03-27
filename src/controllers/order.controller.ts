import { Request, Response } from 'express';
import Order from '@/models/order-model';
import Cart from '@/models/cart-model';
import { trackEvent } from '@/services/track-event.service';
import { createPaylukCustomer } from '@/services/payluk.service';
import { User } from '@/models/user-model';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

const ensurePaylukCustomer = async (req: Request): Promise<string> => {
  const authUser = (req as any).user;
  const userId = authUser?._id || authUser?.id || authUser?.userId;

  // Fast path: already on JWT
  if (authUser?.paylukCustomerId) return authUser.paylukCustomerId;

  // Fetch fresh from DB — bvn is select:false so we opt-in explicitly
  const dbUser = await User.findById(userId).select('+bvn');
  if (!dbUser) throw new Error('User not found');

  // Already registered
  if (dbUser.paylukCustomerId) return dbUser.paylukCustomerId;

  // Phone + BVN required to register with Payluk
  if (!dbUser.phone || !dbUser.bvn) {
    const err: any = new Error('PAYLUK_SETUP_REQUIRED');
    err.statusCode = 422;
    err.missingFields = { phone: !dbUser.phone, bvn: !dbUser.bvn };
    throw err;
  }

  console.log('ℹ️  Creating Payluk customer for user', userId);

  const result = await createPaylukCustomer({
    firstName: dbUser.firstName,
    lastName: dbUser.lastName,
    email: dbUser.email,
    phone: dbUser.phone,
    bvn: dbUser.bvn,
  });

  dbUser.paylukCustomerId = result.customerId;
  await dbUser.save();

  console.log(`✅ Payluk customer created: ${result.customerId} for user ${userId}`);
  return result.customerId;
};

// ─────────────────────────────────────────────
// 1. PLACE ORDER (CHECKOUT)
// ─────────────────────────────────────────────
export const createOrderFromCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const { shippingAddress, paymentMethod } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized: user not found in request' });
    }

    const cart = await Cart.findOne({ user: userId }).populate('items.product');
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const firstItem: any = cart.items[0].product;
    const businessId = firstItem.business;

    let totalAmount = 0;
    const orderItems = [];

    // Stock check only — stock is deducted in the webhook after confirmed payment
    for (const item of cart.items) {
      const p: any = item.product;
      if (p.stock < item.quantity) {
        return res.status(400).json({ message: `${p.name} is out of stock` });
      }
      orderItems.push({
        product: p._id,
        name: p.name,
        price: p.price,
        quantity: item.quantity,
        image: p.media?.[0]
      });
      totalAmount += p.price * item.quantity;
    }

    // Persist order first so we have an ID before calling Payluk
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
    await Cart.findOneAndDelete({ user: userId });

    // Auto-create Payluk customer if user doesn't have one yet
    const paylukCustomerId = await ensurePaylukCustomer(req);
    console.log('🔍 paylukCustomerId:', paylukCustomerId);

    // const callbackUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payments/complete`;

    // Create the escrow — returns a paymentToken for the Inline Checkout widget
    // const escrowResult = await createEscrow({
    //   amount: totalAmount,
    //   purpose: `Order ${newOrder.orderNumber}`,
    //   description: orderItems.map(i => `${i.name} x${i.quantity}`).join(', '),
    //   whoPays: 'buyer',
    //   totalQuantity: orderItems.reduce((sum, i) => sum + i.quantity, 0),
    //   callbackUrl,
    //   customerId: paylukCustomerId,
    // });

    // ✅ Card payment is triggered client-side via the Payluk Inline Checkout widget.
    // We do NOT call POST /payment/escrow here — that endpoint is for wallet payments only.
    newOrder.payment = {
      provider: 'payluk',
      // transactionRef: escrowResult.paymentToken,
      // details: { escrowResult: escrowResult.raw }
    } as any;
    await newOrder.save();

    await trackEvent({
      targetId: (newOrder._id as any).toString(),
      targetModel: 'Order',
      type: 'ACTIVITY',
      activityData: {
        action: 'ORDER_PLACED',
        description: `You placed order ${newOrder.orderNumber} for NGN ${totalAmount}`,
        metadata: { ip: req.ip, userAgent: req.headers['user-agent'] }
      }
    });

    return res.status(201).json({
      message: 'Order created. Complete payment with Payluk.',
      order: newOrder,
      payluk: {
        // paymentToken: escrowResult.paymentToken,  // frontend passes this to widget
        // escrowId: escrowResult.escrowId,
        customerId: paylukCustomerId,
      }
    });

  } catch (error: any) {
    console.error('❌ [createOrderFromCart]:', error?.response?.data || error?.message || error);

    if (error?.message === 'PAYLUK_SETUP_REQUIRED') {
      return res.status(422).json({
        message: 'Payment profile incomplete. Please complete your payment setup.',
        code: 'PAYLUK_SETUP_REQUIRED',
        missingFields: error.missingFields
      });
    }

    return res.status(500).json({
      message: 'Order creation failed',
      error: error?.response?.data || error?.message || error
    });
  }
};

// ─────────────────────────────────────────────
// 2. GET ORDER HISTORY
// ─────────────────────────────────────────────
export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find({ user: getAuthUserId(req) }).sort({ createdAt: -1 });
    return res.status(200).json(orders);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch orders', error });
  }
};

// ─────────────────────────────────────────────
// 3. GET SINGLE ORDER
// ─────────────────────────────────────────────
export const getOrderById = async (req: Request, res: Response) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.user.toString() !== getAuthUserId(req)) {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    return res.status(200).json(order);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch order', error });
  }
};

// ─────────────────────────────────────────────
// 4. MANUALLY REGISTER PAYLUK CUSTOMER
// POST /order/setup-payment-profile
// ─────────────────────────────────────────────
export const setupPaylukCustomer = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const dbUser = await User.findById(userId).select('+bvn');
    if (!dbUser) return res.status(404).json({ message: 'User not found' });

    // Idempotent — never create twice
    if (dbUser.paylukCustomerId) {
      return res.status(200).json({
        message: 'Payment profile already set up',
        paylukCustomerId: dbUser.paylukCustomerId
      });
    }

    const { phone, bvn } = req.body;

    if (!phone || !bvn) {
      return res.status(400).json({ message: 'Phone number and BVN are required' });
    }

    // Save phone + BVN to user record first
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
      paylukCustomerId: result.customerId
    });

  } catch (error: any) {
    console.error('❌ [setupPaylukCustomer]:', error?.response?.data || error);
    return res.status(500).json({
      message: 'Failed to set up payment profile',
      error: error?.response?.data || error?.message || error
    });
  }
};