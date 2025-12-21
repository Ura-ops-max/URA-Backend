import { Schema, model } from "mongoose";


const wishlistSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
}, { timestamps: true });

// Ensure a user can't wishlist the same product twice
wishlistSchema.index({ user: 1, product: 1 }, { unique: true });

export const Wishlist = model('Wishlist', wishlistSchema);