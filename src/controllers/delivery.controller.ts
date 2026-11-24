import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '@/middleware/errorHandler';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import Order from '@/models/order-model';
import {
  isFezConfigured,
  createDeliveryOrder,
  trackDeliveryOrder,
  FezError,
} from '@/services/fez.service';
import { ChowdeckError, getChowdeckDelivery } from '@/services/chowdeck.service';
import {
  anyCourierConfigured,
  normaliseChowdeckTracking,
  normaliseFezTracking,
  PROVIDER_NAME,
  quoteDelivery,
  STATUS_LABEL,
  type DeliveryStatus,
} from '@/services/courier.service';
import { isAdminUser } from '@/utils/admin.utils';

const notConfigured = (res: Response) =>
  res.status(503).json({ success: false, message: 'Delivery service is not configured.' });

const handleFezError = (res: Response, err: unknown) => {
  const known = err instanceof FezError || err instanceof ChowdeckError;
  const status = known ? err.statusCode : 502;
  const message = known ? err.message : 'Delivery request failed';
  res.status(status).json({ success: false, message });
};

const optionalNumber = (v: unknown): number | null =>
  v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

// POST /delivery/cost
//   { state, city?, fullAddress?, latitude?, longitude?, businessId?, productId?, pickUpState?, weight? }
// The courier is chosen like checkout does (courier.service): Chowdeck for a
// same-city route it serves, otherwise Fez. `state` alone still quotes Fez.
// The pickup comes from the SELLER's business profile (businessId or productId).
// Response: data.totalCost as before, plus data.provider, data.providerName
// and (Chowdeck) data.eta. Fez quotes keep their other fields (cost, vat, state, raw).
export const deliveryCost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!anyCourierConfigured()) {
    notConfigured(res);
    return;
  }

  const { state, weight, businessId, productId, city, fullAddress } = req.body;
  let { pickUpState } = req.body;

  if (!state || typeof state !== 'string') {
    res.status(400).json({ success: false, message: 'Destination state is required.' });
    return;
  }

  // The seller's business: its state (Fez) and its address/location (Chowdeck).
  let business: any = null;
  if (businessId && Types.ObjectId.isValid(String(businessId))) {
    business = await Business.findById(businessId).select('address location').lean();
  } else if (productId && Types.ObjectId.isValid(String(productId))) {
    const product = await Product.findById(productId).select('business').lean();
    if (product?.business) {
      business = await Business.findById(product.business).select('address location').lean();
    }
  }
  if (!pickUpState) pickUpState = business?.address?.state || undefined;

  if (!pickUpState) {
    res.status(400).json({
      success: false,
      code: 'PICKUP_STATE_MISSING',
      message: "The seller hasn't set their business location yet, so delivery can't be quoted.",
    });
    return;
  }

  try {
    const quote = await quoteDelivery({
      shop: business,
      pickUpState: String(pickUpState),
      dropoff: {
        state,
        city: typeof city === 'string' ? city : null,
        fullAddress: typeof fullAddress === 'string' ? fullAddress : null,
        latitude: optionalNumber(req.body.latitude),
        longitude: optionalNumber(req.body.longitude),
      },
      ...(weight != null ? { weight: Number(weight) } : {}),
    });
    const extra = {
      provider: quote.provider,
      providerName: PROVIDER_NAME[quote.provider],
      ...(quote.eta ? { eta: quote.eta } : {}),
    };
    // Nest under `data` — the frontend reads `response.data.data`.
    const data = quote.fez
      ? { ...quote.fez, ...extra }
      : { cost: quote.totalCost, vat: 0, totalCost: quote.totalCost, state, ...extra };
    res.status(200).json({ success: true, data });
  } catch (err) {
    handleFezError(res, err);
  }
});

// POST /delivery/create  → create a Fez shipment for an order
export const deliveryCreate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!isFezConfigured()) {
    notConfigured(res);
    return;
  }

  const {
    uniqueID,
    recipientName,
    recipientPhone,
    recipientAddress,
    recipientState,
    valueOfItem,
    weight,
    recipientEmail,
    itemDescription,
    pickUpState,
    pickUpAddress,
  } = req.body;

  if (
    !uniqueID ||
    !recipientName ||
    !recipientPhone ||
    !recipientAddress ||
    !recipientState ||
    valueOfItem == null
  ) {
    res.status(400).json({ success: false, message: 'Missing required delivery fields.' });
    return;
  }

  try {
    const result = await createDeliveryOrder({
      uniqueID,
      recipientName,
      recipientPhone,
      recipientAddress,
      recipientState,
      valueOfItem,
      weight,
      recipientEmail,
      itemDescription,
      pickUpState,
      pickUpAddress,
    });
    res.status(201).json({ success: true, trackingNo: result.trackingNo });
  } catch (err) {
    handleFezError(res, err);
  }
});

// GET /delivery/track/:trackingNumber
// Only the order's buyer, its seller or an admin. One shape for both couriers:
// { provider, status, statusLabel, trackingUrl, rider, timeline, raw }, plus
// deliveryPin for the buyer only (never the seller). `raw` is the courier's own
// response (today's apps render Fez's format from it).
export const deliveryTrack = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const tracking = String(req.params.trackingNumber ?? '').trim();
  const order: any = await Order.findOne({
    $or: [{ trackingNumber: tracking }, { orderNumber: tracking }],
  })
    .select(
      '+deliveryPin user business fulfilment trackingNumber trackingUrl deliveryStatus orderNumber'
    )
    .lean();
  if (!tracking || !order) {
    res.status(404).json({ success: false, message: 'Tracking number not found.' });
    return;
  }

  const userId = String((req as any).user?._id ?? '');
  const isBuyer = String(order.user) === userId;
  const ownsShop = await Business.exists({ _id: order.business, owner: userId });
  if (!isBuyer && !ownsShop && !(await isAdminUser(userId))) {
    res.status(403).json({ success: false, message: 'You cannot track this order.' });
    return;
  }
  const pin = isBuyer && order.deliveryPin ? { deliveryPin: order.deliveryPin } : {};

  if (order.fulfilment === 'chowdeck') {
    try {
      const raw = await getChowdeckDelivery(order.trackingNumber || order.orderNumber);
      const data = normaliseChowdeckTracking(raw, { trackingUrl: order.trackingUrl });
      res.status(200).json({ success: true, data: { ...data, ...pin } });
    } catch {
      // Chowdeck unreachable: answer with the last status we stored.
      const status = (order.deliveryStatus as DeliveryStatus) || 'booked';
      res.status(200).json({
        success: true,
        data: {
          provider: 'chowdeck',
          status,
          statusLabel: STATUS_LABEL[status] ?? STATUS_LABEL.booked,
          trackingUrl: order.trackingUrl ?? null,
          rider: null,
          timeline: [],
          raw: null,
          ...pin,
        },
      });
    }
    return;
  }

  if (order.fulfilment === 'fez' || (!order.fulfilment && order.trackingNumber)) {
    if (!isFezConfigured()) {
      notConfigured(res);
      return;
    }
    try {
      const raw = await trackDeliveryOrder(order.trackingNumber);
      res.status(200).json({ success: true, data: { ...normaliseFezTracking(raw), ...pin } });
    } catch (err) {
      handleFezError(res, err);
    }
    return;
  }

  res.status(400).json({ success: false, message: 'This order is not with a courier.' });
});
