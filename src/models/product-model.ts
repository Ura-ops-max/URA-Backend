import { Schema, model, Document, Types } from 'mongoose';
import { invalidateSeoForBusiness } from '@/seo/cache';
import { DeletedProduct } from './deleted-product-model';

export interface IProduct extends Document {
  business: Types.ObjectId;
  name: string;
  category: string;
  description: string;
  price: number;
  stock: number;
  size?: string;
  media: string[];
  /** Shop's own item code. Inventory uploads match on this (unique per shop). */
  sku?: string;
  barcode?: string;
  /** e.g. "pack", "kg", "bottle" — display only. */
  unit?: string;
  /** Switched "Off" by the owner: hidden from shoppers, can't be bought. */
  isHidden?: boolean;
  /** Buyer-Protected Payment: who pays Payluk's fee (the seller's choice). */
  whoPays?: 'buyer' | 'seller' | 'both';
  /** Delivery window for the escrow (Payluk: 1..365 minutes/hours/days). */
  maxDelivery?: number;
  deliveryTimeline?: 'minutes' | 'hours' | 'days';
  likes: Types.ObjectId[];
  averageRating: number;
  totalReviews: number;

  // Image-search: CLIP embedding of the product's first image (1024 dims).
  // Populated on create/update; queried via Atlas $vectorSearch.
  imageEmbedding?: number[];

  // ── Payluk Escrow ──────────────────────────────
  paylukEscrowId: string | null;
  paylukPaymentToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const productSchema = new Schema<IProduct>(
  {
    business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'General', index: true },
    // Optional at the database level: bulk-uploaded items may have none.
    // (Single-product uploads still require it in the request validator.)
    description: { type: String, default: '' },
    price: { type: Number, required: true },
    stock: { type: Number, required: true, default: 0 },
    size: { type: String },
    media: [{ type: String, required: true }],
    sku: { type: String, trim: true },
    barcode: { type: String, trim: true },
    unit: { type: String, trim: true },
    isHidden: { type: Boolean, default: false, index: true },
    whoPays: { type: String, enum: ['buyer', 'seller', 'both'] },
    maxDelivery: { type: Number },
    deliveryTimeline: { type: String, enum: ['minutes', 'hours', 'days'] },
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    // Vector for Atlas image search (select:false — never sent to clients).
    imageEmbedding: { type: [Number], select: false, default: undefined },

    // RATING FIELDS
    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
      index: true, // Crucial for search performance
    },
    totalReviews: {
      type: Number,
      default: 0,
    },

    // PAYLUK FIELDS
    paylukEscrowId: { type: String, default: null },
    paylukPaymentToken: { type: String, default: null },
  },
  { timestamps: true }
);

// Optional: Add a text index for name and description to improve the 'q' search logic
productSchema.index({ name: 'text', description: 'text' });

// Inventory re-uploads match a shop's rows on SKU.
productSchema.index({ business: 1, sku: 1 });

/** Query filter for products shoppers may see and buy (not switched Off). */
// Built shop/product pages (Google visibility) are refreshed when a product
// changes; a deleted product is remembered so its page says "410 Gone".
productSchema.post('save', (doc: any) => invalidateSeoForBusiness(doc?.business));
productSchema.post('findOneAndUpdate', (doc: any) => doc && invalidateSeoForBusiness(doc.business));
productSchema.post('findOneAndDelete', async (doc: any) => {
  if (!doc) return;
  invalidateSeoForBusiness(doc.business);
  await DeletedProduct.updateOne(
    { productId: doc._id },
    { $setOnInsert: { business: doc.business, deletedAt: new Date() } },
    { upsert: true }
  ).catch(() => undefined);
});

export const VISIBLE_PRODUCT = { isHidden: { $ne: true } } as const;

export const Product = model<IProduct>('Product', productSchema);
