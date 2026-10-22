import mongoose, { Schema, Document } from 'mongoose';

/** One browser's web push subscription (sellers' "New paid order" alerts). */
export interface IPushSubscription extends Document {
  user: mongoose.Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const PushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
    keys: {
      p256dh: { type: String, required: true, maxlength: 200 },
      auth: { type: String, required: true, maxlength: 100 },
    },
  },
  { timestamps: true }
);

export const PushSubscription = mongoose.model<IPushSubscription>(
  'PushSubscription',
  PushSubscriptionSchema
);
