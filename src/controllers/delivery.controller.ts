import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '@/middleware/errorHandler';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import {
  isFezConfigured,
  getDeliveryCost,
  createDeliveryOrder,
  trackDeliveryOrder,
  FezError,
} from '@/services/fez.service';

const notConfigured = (res: Response) =>
  res.status(503).json({ success: false, message: 'Delivery service is not configured.' });

const handleFezError = (res: Response, err: unknown) => {
  const status = err instanceof FezError ? err.statusCode : 502;
  const message = err instanceof FezError ? err.message : 'Delivery request failed';
  res.status(status).json({ success: false, message });
};

// POST /delivery/cost  { state, businessId?, productId?, pickUpState?, weight? }
// The pickup state is taken from the SELLER's business profile (address.state).
// Callers only need to send the buyer's destination state plus something that
// identifies the seller (businessId or productId).
export const deliveryCost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!isFezConfigured()) { notConfigured(res); return; }

  const { state, weight, businessId, productId } = req.body;
  let { pickUpState } = req.body;

  if (!state || typeof state !== 'string') {
    res.status(400).json({ success: false, message: 'Destination state is required.' });
    return;
  }

  // Resolve the seller's state from their business profile when not supplied.
  if (!pickUpState) {
    let business = null;
    if (businessId && Types.ObjectId.isValid(String(businessId))) {
      business = await Business.findById(businessId).select('address').lean();
    } else if (productId && Types.ObjectId.isValid(String(productId))) {
      const product = await Product.findById(productId).select('business').lean();
      if (product?.business) {
        business = await Business.findById(product.business).select('address').lean();
      }
    }
    pickUpState = (business as any)?.address?.state || undefined;
  }

  if (!pickUpState) {
    res.status(400).json({
      success: false,
      code: 'PICKUP_STATE_MISSING',
      message: "The seller hasn't set their business location yet, so delivery can't be quoted.",
    });
    return;
  }

  try {
    const result = await getDeliveryCost({
      state,
      pickUpState: String(pickUpState),
      ...(weight != null ? { weight: Number(weight) } : {}),
    });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    handleFezError(res, err);
  }
});

// POST /delivery/create  → create a Fez shipment for an order
export const deliveryCreate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!isFezConfigured()) { notConfigured(res); return; }

  const {
    uniqueID, recipientName, recipientPhone, recipientAddress, recipientState,
    valueOfItem, weight, recipientEmail, itemDescription, pickUpState, pickUpAddress,
  } = req.body;

  if (!uniqueID || !recipientName || !recipientPhone || !recipientAddress || !recipientState || valueOfItem == null) {
    res.status(400).json({ success: false, message: 'Missing required delivery fields.' });
    return;
  }

  try {
    const result = await createDeliveryOrder({
      uniqueID, recipientName, recipientPhone, recipientAddress, recipientState,
      valueOfItem, weight, recipientEmail, itemDescription, pickUpState, pickUpAddress,
    });
    res.status(201).json({ success: true, trackingNo: result.trackingNo });
  } catch (err) {
    handleFezError(res, err);
  }
});

// GET /delivery/track/:orderNumber
export const deliveryTrack = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!isFezConfigured()) { notConfigured(res); return; }

  try {
    const data = await trackDeliveryOrder(String(req.params.orderNumber));
    res.status(200).json({ success: true, data });
  } catch (err) {
    handleFezError(res, err);
  }
});
