import mongoose, { Schema, Document } from 'mongoose';

export enum OrderStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded'
}

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  name: string;      // Snapshot of name
  price: number;     // Snapshot of price at time of purchase
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
}

const OrderSchema: Schema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  orderNumber: { type: String, required: true, unique: true },
  items: [{
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    image: { type: String }
  }],
  totalAmount: { type: Number, required: true },
  deliveryFee: { type: Number, default: 0 },
  deliveryMethod: { type: String, enum: ['delivery', 'pickup'], default: 'pickup' },
  shippingAddress: {
    // Street/city are optional — checkout collects state + phone, and the
    // rest is pulled from the saved profile when available.
    fullAddress: { type: String },
    city: { type: String },
    state: { type: String },
    phone: { type: String, required: true }
  },
  status: { 
    type: String, 
    enum: Object.values(OrderStatus), 
    default: OrderStatus.PENDING 
  },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'failed'], 
    default: 'pending' 
  },
  paymentMethod: { type: String, required: true },
  payment: {
    provider: String,
    transactionRef: String,
    details: Schema.Types.Mixed
  },

  paylukPaymentToken: { type: String, index: true },
  paylukEscrowId: { type: String, default: null },
  paidAt: Date,
  trackingNumber: { type: String },
  fulfilment: { type: String, enum: ['fez', 'pickup', 'seller_delivery'] }
}, { timestamps: true });

export default mongoose.model<IOrder>('Order', OrderSchema);