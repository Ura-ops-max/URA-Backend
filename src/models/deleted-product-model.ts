import mongoose, { Schema } from 'mongoose';

/**
 * A record that a product existed and was deleted, so its public page can
 * answer "410 Gone" (removed for good) rather than "404 Not Found".
 */
const DeletedProductSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, required: true, unique: true },
  business: { type: Schema.Types.ObjectId },
  deletedAt: { type: Date, default: Date.now },
});

export const DeletedProduct = mongoose.model('DeletedProduct', DeletedProductSchema);
