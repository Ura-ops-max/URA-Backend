/**
 * What the app does with an order's payment. Every function checks that the
 * signed-in user may act on that order, uses THEIR own Payluk customer id, and
 * returns only what the screen needs. The browser never calls Payluk's API;
 * only the Checkout SDK widget talks to Payluk directly.
 */
import mongoose from 'mongoose';
import Order, { IOrder, OrderStatus } from '@/models/order-model';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import {
  Escrow,
  PaylukError,
  amountToPay,
  buyerFeeShare,
  claimEscrow,
  confirmEscrow,
  createEscrow,
  getDispute,
  isFunded,
  payEscrowFromWallet,
  setAdditionalFee,
  resolveDisputeAsRefund,
  submitDispute,
  verifyEscrow,
} from '@/services/payluk.service';
import { applyEscrowState, flagOrder } from '@/services/payment-sync.service';
import { orderActions } from '@/services/order-view.service';
import { notifyOrderEvent } from '@/services/order-events.service';
import { releaseUnpaidHolds } from '@/services/stock-hold.service';
import { holdExpiry, holdItems } from '@/services/stock-hold.service';
import { toPaylukDeliveryWindow } from '@/utils/delivery-window.utils';
import { invalidateWalletCache } from '@/services/wallet.service';

const fail = (status: number, message: string, code?: string) => {
  const e: any = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

async function loadOrder(orderId: string): Promise<IOrder> {
  if (!mongoose.isValidObjectId(orderId)) throw fail(404, 'Order not found');
  const order = await Order.findById(orderId);
  if (!order) throw fail(404, 'Order not found');
  return order;
}

const isBuyer = (order: IOrder, userId: string) => String(order.user) === userId;

async function isSeller(order: IOrder, userId: string): Promise<boolean> {
  return Boolean(await Business.exists({ _id: order.business, owner: userId }));
}

async function paylukIdOf(userId: unknown): Promise<string | null> {
  const u = await User.findById(userId).select('paylukCustomerId').lean();
  return (u as any)?.paylukCustomerId ?? null;
}

async function sellerPaylukId(order: IOrder): Promise<string | null> {
  const biz = await Business.findById(order.business).select('owner').lean();
  return biz ? paylukIdOf((biz as any).owner) : null;
}

const itemsTotalOf = (order: IOrder) =>
  order.itemsTotal ?? order.items.reduce((s, i) => s + i.price * i.quantity, 0);
const deliveryFeeOf = (order: IOrder) => order.deliveryFeeCharged ?? order.deliveryFee ?? 0;
const additionalFeeOf = (order: IOrder) =>
  Math.round(deliveryFeeOf(order) + (order.platformFee ?? 0));

export interface PaymentBreakdown {
  items: number;
  delivery: number;
  serviceFee: number;
  total: number;
}

const breakdownFor = (order: IOrder, escrow: Escrow): PaymentBreakdown => ({
  items: itemsTotalOf(order),
  delivery: deliveryFeeOf(order),
  // URA's platform charge + the buyer's share of Payluk's fee.
  serviceFee: round2((order.platformFee ?? 0) + buyerFeeShare(escrow)),
  total: amountToPay(escrow),
});

// ─── POST /orders/:id/pay ────────────────────────────────────────────────────

export interface StartPaymentResult {
  paymentToken: string;
  reference: string;
  amountToPay: number;
  breakdown: PaymentBreakdown;
  /** The buyer's own Payluk customer id, for the SDK's customerId. */
  customerId: string;
  paymentType: 'normal' | 'protected';
}

/**
 * Create (or reuse) the order's escrow and return what the SDK needs.
 * The escrow holds the goods only; delivery + URA's charge are its
 * additionalFee, paid to URA's merchant wallet (never to the seller).
 */
export async function startPayment(orderId: string, userId: string): Promise<StartPaymentResult> {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId)) throw fail(403, 'This is not your order');
  if (order.paymentStatus === 'paid') throw fail(409, 'This order is already paid', 'ALREADY_PAID');
  if ([OrderStatus.CANCELLED, OrderStatus.REFUNDED].includes(order.status)) {
    throw fail(409, 'This order can no longer be paid');
  }

  const buyerId = await paylukIdOf(userId);
  if (!buyerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  const paymentType = order.paymentType === 'normal' ? 'normal' : 'protected';
  const itemsTotal = itemsTotalOf(order);
  const additionalFee = additionalFeeOf(order);

  // The stock hold may have expired while the buyer was away: take it again.
  if (!order.stockReserved) {
    await holdItems(order.items);
    await Order.updateOne(
      { _id: order._id, paymentStatus: 'pending' },
      { $set: { stockReserved: true, reservedUntil: holdExpiry() } }
    );
  }

  // Normal: seller pays Payluk's fee. Buyer-Protected: the product's setting.
  const firstProduct: any = await Product.findById(order.items[0]?.product)
    .select('whoPays maxDelivery deliveryTimeline')
    .lean();
  const whoPays = paymentType === 'normal' ? 'seller' : firstProduct?.whoPays || 'buyer';

  // Reuse the order's escrow while it is still unpaid and matches the order.
  let escrow: Escrow | null = null;
  if (order.paylukPaymentToken) {
    try {
      escrow = await verifyEscrow(order.paylukPaymentToken);
    } catch (e) {
      if (!(e instanceof PaylukError && e.code === 'NOT_FOUND')) throw e;
    }
    if (escrow && isFunded(escrow)) {
      await applyEscrowState(order, escrow);
      throw fail(409, 'This order is already paid', 'ALREADY_PAID');
    }
    const reusable =
      escrow &&
      escrow.state === 'AWAITING_PAYMENT' &&
      escrow.amount === itemsTotal &&
      escrow.whoPays === whoPays &&
      (escrow.totalQuantity == null || Number(escrow.totalQuantity) === 1);
    if (!reusable) escrow = null;
  }

  if (!escrow) {
    const sellerId = await sellerPaylukId(order);
    if (!sellerId) throw fail(422, 'This shop cannot take payments yet.', 'PRODUCT_NOT_AVAILABLE');
    const itemsText = order.items.map(i => `${i.name} x${i.quantity}`).join(', ');
    escrow = await createEscrow({
      sellerCustomerId: sellerId,
      amount: itemsTotal,
      purpose: `URA order ${order.orderNumber}`,
      description: itemsText,
      whoPays,
      ...toPaylukDeliveryWindow(firstProduct?.maxDelivery, firstProduct?.deliveryTimeline),
    });
    // Save the escrow at once, so a failure below can reuse it next time.
    await Order.updateOne(
      { _id: order._id },
      { $set: { paylukEscrowId: escrow.id, paylukPaymentToken: escrow.paymentToken } }
    );
  }

  if (escrow.additionalFee !== additionalFee) {
    escrow = await setAdditionalFee(escrow.paymentToken, additionalFee);
  }

  // A unique reference per checkout attempt: the order id, then -2, -3 …
  const attempt = (order.paylukReferences?.length ?? 0) + 1;
  const reference = attempt === 1 ? String(order._id) : `${order._id}-${attempt}`;
  await Order.updateOne(
    { _id: order._id },
    {
      $push: { paylukReferences: reference },
      $set: { paylukState: escrow.state, paylukStatus: escrow.status },
    }
  );

  return {
    paymentToken: escrow.paymentToken,
    reference,
    amountToPay: amountToPay(escrow),
    breakdown: breakdownFor(order, escrow),
    customerId: buyerId,
    paymentType,
  };
}

// ─── GET /orders/:id/payment-status ──────────────────────────────────────────

// Each check is a Payluk call, and Payluk allows only 10 a minute for ALL of
// URA. Ask Payluk at most every 20 seconds per order (3 a minute); the webhook
// normally marks the order paid first, and this is only the fallback.
const lastVerified = new Map<string, number>();
const VERIFY_EVERY_MS = 20_000;

export async function getPaymentStatus(orderId: string, userId: string) {
  let order = await loadOrder(orderId);
  if (!isBuyer(order, userId) && !(await isSeller(order, userId))) {
    throw fail(403, 'This is not your order');
  }

  const key = String(order._id);
  const due = Date.now() - (lastVerified.get(key) ?? 0) >= VERIFY_EVERY_MS;
  if (order.paymentStatus === 'pending' && order.paylukPaymentToken && due) {
    lastVerified.set(key, Date.now());
    try {
      order = await applyEscrowState(order, await verifyEscrow(order.paylukPaymentToken));
    } catch (e) {
      // Payluk busy or down: report what we know; the webhook will catch up.
      console.warn(`[payment-status] verify failed for ${key}:`, (e as Error).message);
    }
  }

  return {
    paymentStatus: order.paymentStatus,
    status: order.status,
    paymentType: order.paymentType ?? 'protected',
    payoutReleased: Boolean(order.payoutReleasedAt),
    disputeStatus: order.disputeStatus ?? null,
  };
}

// ─── POST /orders/:id/pay-from-wallet ────────────────────────────────────────

/** Pay from the buyer's Payluk wallet. Only ever runs when the buyer taps it. */
export async function payFromWallet(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId)) throw fail(403, 'This is not your order');
  if (order.paymentStatus === 'paid') throw fail(409, 'This order is already paid', 'ALREADY_PAID');
  if (!order.paylukPaymentToken || !order.paylukEscrowId) {
    throw fail(409, 'Start the payment first.', 'PAYMENT_NOT_STARTED');
  }
  const buyerId = await paylukIdOf(userId);
  if (!buyerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  // Read the escrow first: Payluk rejects any amount but the exact total.
  const escrow = await verifyEscrow(order.paylukPaymentToken);
  if (isFunded(escrow)) {
    await applyEscrowState(order, escrow);
    return getPaymentStatus(orderId, userId);
  }
  if (escrow.state !== 'AWAITING_PAYMENT') throw fail(409, 'This order can no longer be paid');

  try {
    await payEscrowFromWallet({
      buyerCustomerId: buyerId,
      escrowId: escrow.id,
      amount: amountToPay(escrow),
      reference: `${order._id}-wallet-${(order.paylukReferences?.length ?? 0) + 1}`,
    });
  } catch (e) {
    if (e instanceof PaylukError && /insufficient balance/i.test(e.message)) {
      throw fail(400, 'Your wallet balance is not enough for this order.', 'INSUFFICIENT_BALANCE');
    }
    throw e;
  }
  invalidateWalletCache(buyerId);

  // Payluk reports the escrow OPENED on success; confirm and apply it.
  await applyEscrowState(order, await verifyEscrow(order.paylukPaymentToken));
  lastVerified.set(String(order._id), Date.now());
  return getPaymentStatus(orderId, userId);
}

// ─── POST /orders/:id/confirm-received (Buyer-Protected) ─────────────────────

export async function confirmReceived(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId)) throw fail(403, 'Only the buyer can confirm this order');
  if (order.paymentType === 'normal') {
    throw fail(400, 'Normal Payment is paid to the seller automatically.', 'NORMAL_PAYMENT');
  }
  if (order.paymentStatus !== 'paid') throw fail(400, 'This order has not been paid yet');
  if (order.payoutReleasedAt)
    throw fail(409, 'This order is already completed', 'ALREADY_RELEASED');
  if (order.rejectedAt) {
    throw fail(400, 'The shop rejected this order. Tap "Get my money back" instead.', 'REJECTED');
  }
  if (['open', 'investigating'].includes(order.disputeStatus ?? '')) {
    throw fail(400, 'A problem was reported on this order. It is on hold until it is resolved.');
  }
  if (!order.paylukPaymentToken || !order.paylukEscrowId)
    throw fail(409, 'No payment found for this order');

  const escrow = await verifyEscrow(order.paylukPaymentToken);
  if (escrow.state !== 'OPENED' || escrow.status !== 'ONGOING') {
    await applyEscrowState(order, escrow);
    throw fail(409, 'This order cannot be confirmed right now.', 'NOT_CONFIRMABLE');
  }
  const buyerId = await paylukIdOf(userId);
  if (!buyerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  const after = await confirmEscrow(order.paylukEscrowId, buyerId);
  const updated = await applyEscrowState(order, after.id ? after : escrow);
  return { status: updated.status, payoutReleased: Boolean(updated.payoutReleasedAt) };
}

// ─── Disputes (Buyer-Protected) ──────────────────────────────────────────────

/** Buyer opens a dispute; the seller can reply once one is open. */
export async function submitOrderDispute(
  orderId: string,
  userId: string,
  message: string,
  file?: { buffer: Buffer; originalname: string; mimetype: string }
) {
  const order = await loadOrder(orderId);
  const buyer = isBuyer(order, userId);
  const seller = !buyer && (await isSeller(order, userId));
  if (!buyer && !seller) throw fail(403, 'This is not your order');
  if (order.paymentType === 'normal') {
    throw fail(400, 'Normal Payment orders have no buyer protection.', 'NORMAL_PAYMENT');
  }
  // Payluk: only the buyer opens (once); the seller replies once, after that.
  const allowed = orderActions(order, buyer ? 'buyer' : 'seller');
  if (buyer && !allowed.reportProblem)
    throw fail(400, 'A problem can no longer be reported on this order.');
  if (seller && !allowed.respondToProblem)
    throw fail(400, 'There is no open problem to respond to.');
  if (!message?.trim()) throw fail(400, 'Please describe the problem.');
  if (!order.paylukPaymentToken) throw fail(409, 'No payment found for this order');

  const customerId = await paylukIdOf(userId);
  if (!customerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  // Claim the one submission first, so a double tap can't send two.
  const field = buyer ? 'buyerReportedAt' : 'sellerRespondedAt';
  const claimed = await Order.updateOne(
    { _id: order._id, [field]: { $exists: false } },
    { $set: { [field]: new Date() } }
  );
  if (!claimed.modifiedCount) throw fail(409, 'This was already sent.', 'ALREADY_SENT');

  let escrow: Escrow;
  try {
    escrow = await submitDispute({
      paymentToken: order.paylukPaymentToken,
      customerId,
      message: message.trim(),
      file: file
        ? { buffer: file.buffer, filename: file.originalname, mimetype: file.mimetype }
        : undefined,
    });
  } catch (e) {
    await Order.updateOne({ _id: order._id }, { $unset: { [field]: 1 } });
    throw e;
  }
  const updated = await applyEscrowState(
    order,
    escrow.id ? escrow : await verifyEscrow(order.paylukPaymentToken)
  );
  return { disputeStatus: updated.disputeStatus ?? null };
}

export async function getOrderDispute(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId) && !(await isSeller(order, userId))) {
    throw fail(403, 'This is not your order');
  }
  if (!order.paylukEscrowId || !order.disputeStatus) return { dispute: null };
  const customerId = await paylukIdOf(userId);
  if (!customerId) return { dispute: null };
  // Payluk returns the escrow with a `dispute` list:
  // [{ name, message, proofUrl, type: 'buyer' | 'seller', createdAt }].
  const escrow = await getDispute(order.paylukEscrowId, customerId);
  const entries = Array.isArray(escrow?.dispute) ? escrow.dispute : [];
  return {
    dispute: {
      status: order.disputeStatus,
      openedAt: order.disputedAt ?? null,
      entries: entries.map((m: any) => ({
        from: m?.type === 'seller' ? 'seller' : 'buyer',
        name: m?.name ?? null,
        message: m?.message ?? null,
        proofUrl: m?.proofUrl ?? null,
        at: m?.createdAt ?? null,
      })),
    },
  };
}

// ─── POST /orders/:id/claim (seller, Buyer-Protected) ────────────────────────

/** Seller claims the money one day after the delivery window (Payluk's rule). */
export async function claimOrderFunds(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!(await isSeller(order, userId))) throw fail(403, 'Only the seller can claim this order');
  if (order.paymentType === 'normal') {
    throw fail(400, 'Normal Payment is paid to you automatically.', 'NORMAL_PAYMENT');
  }
  if (order.paymentStatus !== 'paid' || order.payoutReleasedAt) throw fail(400, 'Nothing to claim');
  if (['open', 'investigating'].includes(order.disputeStatus ?? '')) {
    throw fail(409, 'This order has an open dispute.');
  }
  if (!order.paylukPaymentToken) throw fail(409, 'No payment found for this order');
  const sellerId = await paylukIdOf(userId);
  if (!sellerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  try {
    const escrow = await claimEscrow(order.paylukPaymentToken, sellerId);
    const updated = await applyEscrowState(
      order,
      escrow.id ? escrow : await verifyEscrow(order.paylukPaymentToken)
    );
    return { payoutReleased: Boolean(updated.payoutReleasedAt) };
  } catch (e) {
    if (e instanceof PaylukError && /cannot be claimed yet/i.test(e.message)) {
      throw fail(400, 'You can claim this one day after the delivery window ends.', 'TOO_EARLY');
    }
    throw e;
  }
}

// ─── Cancel (buyer, unpaid) ──────────────────────────────────────────────────

/** The buyer cancels an order they have not paid for. Its stock goes back. */
export async function cancelOrder(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId)) throw fail(403, 'This is not your order');
  if (!orderActions(order, 'buyer').cancel)
    throw fail(400, 'This order can no longer be cancelled.');
  await releaseUnpaidHolds({ _id: order._id });
  const done = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: 'pending', status: { $nin: ['cancelled', 'refunded'] } },
    { $set: { status: OrderStatus.CANCELLED, cancelledAt: new Date() } },
    { new: true }
  );
  if (!done) throw fail(409, 'This order can no longer be cancelled.');
  return { status: done.status };
}

// ─── Reject (seller, paid Buyer-Protected, not shipped) ──────────────────────

/**
 * The shop can't fill a paid order. Its stock goes back at once and the buyer
 * is told to tap "Get my money back". Payluk refunds only through a dispute
 * the buyer opens, so the refund itself is the buyer's one tap (requestRefund).
 */
export async function rejectOrder(orderId: string, userId: string, reason?: string) {
  const order = await loadOrder(orderId);
  if (!(await isSeller(order, userId))) throw fail(403, 'Only the shop can reject this order');
  if (order.paymentType === 'normal') {
    throw fail(
      400,
      'Normal Payment is already paid to you. Contact URA support to refund the buyer.',
      'NORMAL_PAYMENT'
    );
  }
  if (!orderActions(order, 'seller').reject)
    throw fail(400, 'This order can no longer be rejected.');

  const done = await Order.findOneAndUpdate(
    {
      _id: order._id,
      rejectedAt: { $exists: false },
      status: OrderStatus.PROCESSING,
      payoutReleasedAt: { $exists: false },
      disputeStatus: { $exists: false },
    },
    {
      $set: {
        rejectedAt: new Date(),
        stockRestoredAt: new Date(),
        ...(reason?.trim() ? { rejectReason: reason.trim().slice(0, 300) } : {}),
      },
    },
    { new: true }
  );
  if (!done) throw fail(409, 'This order can no longer be rejected.');

  // Paid orders had their stock taken: put it back.
  for (const item of done.items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
  }
  notifyOrderEvent(done, 'REJECTED').catch(() => {});
  return { rejected: true };
}

// ─── Get my money back (buyer, after the shop rejected) ─────────────────────

/**
 * Payluk refunds only by resolving a dispute the buyer opened. So this opens
 * one for the buyer and URA resolves it as a full refund straight away
 * (delivery fee included: nothing was delivered).
 */
export async function requestRefund(orderId: string, userId: string) {
  const order = await loadOrder(orderId);
  if (!isBuyer(order, userId)) throw fail(403, 'This is not your order');
  if (!orderActions(order, 'buyer').getRefund)
    throw fail(400, 'This order cannot be refunded here.');
  if (!order.paylukPaymentToken || !order.paylukEscrowId)
    throw fail(409, 'No payment found for this order');
  const buyerId = await paylukIdOf(userId);
  if (!buyerId) throw fail(422, 'Payment profile required', 'PAYLUK_PROFILE_REQUIRED');

  const claimed = await Order.updateOne(
    { _id: order._id, buyerReportedAt: { $exists: false } },
    { $set: { buyerReportedAt: new Date() } }
  );
  if (!claimed.modifiedCount) throw fail(409, 'Your refund is already on its way.', 'ALREADY_SENT');

  try {
    await submitDispute({
      paymentToken: order.paylukPaymentToken,
      customerId: buyerId,
      message: 'The shop rejected this order and could not fill it. Please refund me.',
    });
  } catch (e) {
    await Order.updateOne({ _id: order._id }, { $unset: { buyerReportedAt: 1 } });
    throw e;
  }

  try {
    const escrow = await resolveDisputeAsRefund({
      escrowId: order.paylukEscrowId,
      resolution: `URA: the shop rejected order ${order.orderNumber}. Full refund to the buyer.`,
      additionalFeeRefundable: true,
    });
    const updated = await applyEscrowState(
      order,
      escrow.id ? escrow : await verifyEscrow(order.paylukPaymentToken)
    );
    return {
      refunded: updated.status === OrderStatus.REFUNDED,
      pending: updated.status !== OrderStatus.REFUNDED,
    };
  } catch (e) {
    // The dispute is open; a person must resolve it (e.g. not a super-admin key).
    await flagOrder(
      order._id,
      `Refund after rejection needs resolving in Payluk: ${(e as Error).message}`.slice(0, 300)
    );
    await applyEscrowState(order, await verifyEscrow(order.paylukPaymentToken)).catch(
      () => undefined
    );
    return { refunded: false, pending: true };
  }
}
