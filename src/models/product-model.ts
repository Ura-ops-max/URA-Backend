import { Schema, model, Document, Types } from 'mongoose';

export interface IProduct extends Document {
  business: Types.ObjectId; // Always a Business
  name: string;
  category: string;
  description: string;
  price: number;
  stock: number;
  size?: string;
  media: string[]; // Master images
  createdAt: Date;
  likes: Types.ObjectId[];

}

const productSchema = new Schema<IProduct>({
  business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  name: { type: String, required: true },
  category: { type: String, default: 'General' },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, required: true },
  size: { type: String },
  media: [{ type: String, required: true }], // Product must have images
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }]

}, { timestamps: true });

export const Product = model<IProduct>('Product', productSchema);
export { productSchema }