import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '@/models/user-model';
import { createPaylukCustomer } from '@/services/payluk.service';
import { getAuthUserId } from '@/utils/request.utils';
import * as orderService from '@/services/order.service';

// ─── Onboarding: create Payluk customer ──────────────────────────────────────

export const setupPaylukCustomer = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const dbUser = await User.findById(userId);
    if (!dbUser) return res.status(404).json({ message: 'User not found' });

    if (dbUser.paylukCustomerId) {
      return res.status(200).json({ success: true, message: 'Payment profile already set up', paylukCustomerId: dbUser.paylukCustomerId });
    }

    const { phone, firstName: bodyFirstName, lastName: bodyLastName } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

    const resolvedFirstName = (bodyFirstName?.trim() || dbUser.firstName || '').trim();
    const resolvedLastName  = (bodyLastName?.trim()  || dbUser.lastName  || resolvedFirstName).trim();

    if (!resolvedFirstName) return res.status(400).json({ success: false, message: 'First name is required' });
    if (!dbUser.email)      return res.status(400).json({ success: false, message: 'Email address is required' });

    const session = await mongoose.startSession();
    let customerId!: string;
    try {
      await session.withTransaction(async () => {
        const result = await createPaylukCustomer({ firstName: resolvedFirstName, lastName: resolvedLastName, email: dbUser.email, phone });
        customerId = result.customerId;
        const updates: Record<string, string> = { phone, paylukCustomerId: customerId };
        if (bodyFirstName?.trim()) updates.firstName = resolvedFirstName;
        if (bodyLastName?.trim())  updates.lastName  = resolvedLastName;
        await User.updateOne({ _id: dbUser._id }, updates, { session });
      });
    } finally {
      await session.endSession();
    }

    return res.status(201).json({ success: true, message: 'Payment profile created successfully', paylukCustomerId: customerId });
  } catch (error: any) {
    console.error('[setupPaylukCustomer]:', error?.response?.data || error?.message);
    return res.status(500).json({ success: false, message: error?.message || 'Failed to set up payment profile' });
  }
};

// ─── Checkout ─────────────────────────────────────────────────────────────────

export const createOrderFromCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { paymentMethod, deliveryMethod } = req.body;
    // 'normal' = buyer pays the clean price, seller absorbs Payluk's fee (like
    // Paystack). 'escrow' (default) = buyer pays the fee for held protection.
    const escrowMode = req.body.escrowMode === 'normal' ? 'normal' : 'escrow';
    const bodyAddress = req.body.shippingAddress;
    // Only the delivery option carries a shipping cost; direct payment sends 0.
    const deliveryFee = deliveryMethod === 'delivery' ? Math.max(0, Number(req.body.deliveryFee) || 0) : 0;

    // Fall back to the user's saved shipping address for any missing field
    const dbUser = await User.findById(userId).select('shippingAddress').lean();
    const saved = (dbUser as any)?.shippingAddress ?? {};

    const shippingAddress = {
      fullAddress: bodyAddress?.fullAddress || saved.fullAddress,
      city:        bodyAddress?.city        || saved.city,
      state:       bodyAddress?.state       || saved.state,
      phone:       bodyAddress?.phone       || saved.phone,
    };

    // City & full address are temporarily optional (hidden on the checkout form).
    // Only a phone number is required for now.
    if (!shippingAddress.phone) {
      return res.status(400).json({
        success: false,
        code: 'SHIPPING_REQUIRED',
        message: 'Please provide a phone number for delivery.',
      });
    }

    const result = await orderService.checkoutFromCart(
      userId,
      shippingAddress,
      paymentMethod,
      req.ip,
      req.headers['user-agent'] as string,
      { deliveryFee, deliveryMethod: deliveryMethod === 'delivery' ? 'delivery' : 'pickup', escrowMode },
    );
    return res.status(201).json({ success: true, message: 'Order created successfully', ...result });
  } catch (error: any) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, code: error.code, message: error.message || 'Order creation failed' });
  }
};

// ─── Confirm payment (client-side fallback) ───────────────────────────────────

export const confirmOrderPayment = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ success: false, message: 'paymentId is required' });

    const result = await orderService.confirmPayment(userId, paymentId);
    return res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to confirm payment' });
  }
};

// ─── My Orders ────────────────────────────────────────────────────────────────

export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await orderService.getOrdersForUser(getAuthUserId(req)!);
    return res.status(200).json({ success: true, orders });
  } catch {
    return res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
};

// ─── Single Order ─────────────────────────────────────────────────────────────

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const { order, role } = await orderService.getOrderByIdForUser(String(req.params.id), getAuthUserId(req)!);
    return res.status(200).json({ success: true, order, role });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// ─── Seller: orders customers placed with my business ───────────────────────

export const getReceivedOrders = async (req: Request, res: Response) => {
  try {
    const orders = await orderService.getReceivedOrdersForSeller(getAuthUserId(req)!);
    return res.status(200).json({ success: true, orders });
  } catch {
    return res.status(500).json({ success: false, message: 'Failed to fetch received orders' });
  }
};

// ─── Seller: order is ready (books Fez delivery, or tells buyer to pick up) ──

export const markOrderReady = async (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode === 'self_delivery' ? 'self_delivery' : 'pickup';
    const order = await orderService.markOrderReady(String(req.params.id), getAuthUserId(req)!, mode);
    return res.status(200).json({ success: true, order });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Could not update order' });
  }
};
