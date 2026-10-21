import mongoose, { Schema, Document } from 'mongoose';

/**
 * Every Payluk webhook we accepted, keyed for de-duplication (docs: Webhooks >
 * Be idempotent): escrow events on `escrow:<data.id>:<event>`, payment events
 * on `payment:<data.reference>`. Stores only what is needed to trace an order,
 * never secrets.
 */
export interface IPaylukWebhookEvent extends Document {
  key: string;
  event: string;
  escrowId?: string;
  reference?: string;
  status?: string;
  state?: string;
  environment?: string;
  receivedAt: Date;
}

const PaylukWebhookEventSchema = new Schema<IPaylukWebhookEvent>({
  key: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  escrowId: { type: String, index: true },
  reference: { type: String },
  status: { type: String },
  state: { type: String },
  environment: { type: String },
  receivedAt: { type: Date, default: () => new Date() },
});

export const PaylukWebhookEvent = mongoose.model<IPaylukWebhookEvent>(
  'PaylukWebhookEvent',
  PaylukWebhookEventSchema
);
