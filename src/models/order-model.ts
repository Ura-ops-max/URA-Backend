import mongoose, { Schema, Document } from 'mongoose';

export enum OrderStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  name: string; // Snapshot of name
  price: number; // Snapshot of price at time of purchase
  quantity: number;
  image: string;
}

export interface IPaymentDetails {
  provider: 'payluk';
  transactionRef: string;
  details?: any;
}

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  business: mongoose.Types.ObjectId;
  items: IOrderItem[];
  /** Items subtotal + deliveryFee — this is what the buyer is charged. */
  totalAmount: number;
  /** Fez shipping cost. 0 for direct/pickup payments. */
  deliveryFee: number;
  deliveryMethod: 'delivery' | 'pickup';
  shippingAddress: {
    fullAddress: string;
    city: string;
    state?: string;
    phone: string;
  };
  status: OrderStatus;
  paymentStatus: 'pending' | 'paid' | 'failed';
  paymentMethod: 'card' | 'transfer' | 'wallet';
  payment?: IPaymentDetails;
  paylukPaymentToken?: string; // Stored at checkout; used for confirmation lookup
  paylukEscrowId?: string | null; // Buyer releases this escrow when they confirm receipt
  paidAt?: Date;
  trackingNumber?: string;
  /** How it reaches the buyer: Fez rider, buyer collects, or the shop delivers itself. */
  fulfilment?: 'fez' | 'pickup' | 'seller_delivery';
  orderNumber: string;
  /** Stock was taken off the shelf at checkout and not yet released. */
  stockReserved?: boolean;
  /** Unpaid by then → the held stock goes back on the shelf. */
  reservedUntil?: Date;

  // ── Payluk payment (all optional; older orders don't have them) ──────────
  /** normal = released to the seller as soon as it's paid; protected = held. */
  paymentType?: 'normal' | 'protected';
  /** Checkout references sent to the SDK, one per attempt (unique per attempt). */
  paylukReferences?: string[];
  /** Last escrow state/status we saw from Payluk. */
  paylukState?: string;
  paylukStatus?: string;
  /** Goods subtotal = the escrow amount = the seller's payout before fees. */
  itemsTotal?: number;
  /** URA's platform charge, in additionalFee with delivery. */
  platformFee?: number;
  /** Delivery fee charged to the buyer (= Fez quote at checkout). */
  deliveryFeeCharged?: number;
  /** What Fez quoted for the delivery. URA pays Fez from its own account. */
  fezCost?: number;
  riderBookedAt?: Date;
  /** Payluk paid URA's additionalFee (payment.delivery.success). */
  deliveryFeeReceived?: number;
  deliveryFeeReceivedAt?: Date;
  /** Payluk paid URA's commission share (payment.commission.success). */
  commissionReceived?: number;
  commissionReceivedAt?: Date;
  /** Normal orders: release requested from Payluk. */
  releaseRequestedAt?: Date;
  /** The escrow completed/claimed: the seller has been paid. */
  payoutReleasedAt?: Date;
  /** Buyer-Protected disputes. */
  disputeStatus?: 'open' | 'investigating' | 'refunded' | 'split' | 'resolved';
  disputedAt?: Date;
  splitDetails?: { sellerAmount?: number; buyerAmount?: number; pool?: number };
  /** Needs a person: e.g. Payluk refused the release with 401. */
  adminFlag?: { reason: string; at: Date };

  // ── Order actions (Part 2) ─────────────────────────────────────────────
  cancelledAt?: Date;
  /** The shop can't fill a paid Buyer-Protected order; the buyer gets a refund. */
  rejectedAt?: Date;
  rejectReason?: string;
  /** Stock already put back (so a later refund doesn't add it twice). */
  stockRestoredAt?: Date;
  buyerReportedAt?: Date;
  sellerRespondedAt?: Date;
  /** Payluk lets the seller claim one day after the delivery window. */
  claimableAt?: Date;
  /** Buyer-Protected: paid to the shop automatically at this time (Part 4). */
  autoReleaseAt?: Date;
  /** Wait used when no product has a delivery time. */
  autoReleaseDays?: number;
  /** The buyer was told "Your money goes to <shop> in 6 hours". */
  autoReleaseWarnedAt?: Date;
  /** Who asked Payluk to release (set before the call). */
  releaseRequestedBy?: 'buyer' | 'auto';
  /** Who released the money: the buyer, the auto-release job, or an admin. */
  releasedBy?: 'buyer' | 'auto' | 'admin';
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    orderNumber: { type: String, required: true, unique: true },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product' },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
        image: { type: String },
      },
    ],
    totalAmount: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    deliveryMethod: { type: String, enum: ['delivery', 'pickup'], default: 'pickup' },
    shippingAddress: {
      // Street/city are optional — checkout collects state + phone, and the
      // rest is pulled from the saved profile when available.
      fullAddress: { type: String },
      city: { type: String },
      state: { type: String },
      phone: { type: String, required: true },
    },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },
    paymentMethod: { type: String, required: true },
    payment: {
      provider: String,
      transactionRef: String,
      details: Schema.Types.Mixed,
    },

    paylukPaymentToken: { type: String, index: true },
    paylukEscrowId: { type: String, default: null },
    paidAt: Date,
    trackingNumber: { type: String },
    fulfilment: { type: String, enum: ['fez', 'pickup', 'seller_delivery'] },
    stockReserved: { type: Boolean, default: false },
    reservedUntil: { type: Date },

    paymentType: { type: String, enum: ['normal', 'protected'] },
    paylukReferences: { type: [String], default: undefined },
    paylukState: { type: String },
    paylukStatus: { type: String },
    itemsTotal: { type: Number },
    platformFee: { type: Number },
    deliveryFeeCharged: { type: Number },
    fezCost: { type: Number },
    riderBookedAt: { type: Date },
    deliveryFeeReceived: { type: Number },
    deliveryFeeReceivedAt: { type: Date },
    commissionReceived: { type: Number },
    commissionReceivedAt: { type: Date },
    releaseRequestedAt: { type: Date },
    payoutReleasedAt: { type: Date },
    disputeStatus: {
      type: String,
      enum: ['open', 'investigating', 'refunded', 'split', 'resolved'],
    },
    disputedAt: { type: Date },
    splitDetails: { sellerAmount: Number, buyerAmount: Number, pool: Number },
    adminFlag: { reason: String, at: Date },
    cancelledAt: { type: Date },
    rejectedAt: { type: Date },
    rejectReason: { type: String, maxlength: 300 },
    stockRestoredAt: { type: Date },
    buyerReportedAt: { type: Date },
    sellerRespondedAt: { type: Date },
    claimableAt: { type: Date },
    autoReleaseAt: { type: Date },
    autoReleaseDays: { type: Number, default: 1, min: 1, max: 30 },
    autoReleaseWarnedAt: { type: Date },
    releaseRequestedBy: { type: String, enum: ['buyer', 'auto'] },
    releasedBy: { type: String, enum: ['buyer', 'auto', 'admin'] },
  },
  { timestamps: true }
);

// Finds expired holds quickly.
OrderSchema.index({ paymentStatus: 1, stockReserved: 1, reservedUntil: 1 });
// Webhooks find the order by Payluk's escrow id.
OrderSchema.index({ paylukEscrowId: 1 });
// The auto-release job finds due Buyer-Protected orders quickly.
OrderSchema.index({ paymentStatus: 1, autoReleaseAt: 1 });

export default mongoose.model<IOrder>('Order', OrderSchema);
