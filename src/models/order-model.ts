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

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  business: mongoose.Types.ObjectId; // Track which business this order belongs to
  items: IOrderItem[];
  totalAmount: number;
  shippingAddress: {
    fullAddress: string;
    city: string;
    phone: string;
  };
  status: OrderStatus;
  paymentStatus: 'pending' | 'paid' | 'failed';
  paymentMethod: 'card' | 'transfer' | 'wallet';
  trackingNumber?: string;
  orderNumber: string; // Human readable ID like #ORD-12345
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
  shippingAddress: {
    fullAddress: { type: String, required: true },
    city: { type: String, required: true },
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
  trackingNumber: { type: String }
}, { timestamps: true });

export default mongoose.model<IOrder>('Order', OrderSchema);