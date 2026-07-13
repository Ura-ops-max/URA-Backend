import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
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

// POST /delivery/cost  { state, weight? }  → delivery quote for checkout
export const deliveryCost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!isFezConfigured()) { notConfigured(res); return; }

  const { state, pickUpState, weight } = req.body;
  if (!state || typeof state !== 'string') {
    res.status(400).json({ success: false, message: 'Destination state is required.' });
    return;
  }

  try {
    const result = await getDeliveryCost({ state, pickUpState, weight: weight != null ? Number(weight) : undefined });
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
