import mongoose, { Schema, Document } from 'mongoose';

/**
 * Background work for Payluk, stored in MongoDB so it survives restarts
 * (every deploy restarts the server). One row per job; `key` is unique so the
 * same job can't be queued twice (e.g. "release:<orderId>").
 */
export type PaylukJobType = 'webhook' | 'release';
export type PaylukJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'flagged';

export interface IPaylukJob extends Document {
  key: string;
  type: PaylukJobType;
  status: PaylukJobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  runAt: Date;
  lockedUntil?: Date;
  lastError?: string;
  /** Give up (and flag) after this. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PaylukJobSchema = new Schema<IPaylukJob>(
  {
    key: { type: String, required: true, unique: true },
    type: { type: String, enum: ['webhook', 'release'], required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed', 'flagged'],
      default: 'pending',
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    attempts: { type: Number, default: 0 },
    runAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date },
    lastError: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

PaylukJobSchema.index({ status: 1, runAt: 1 });

export const PaylukJob = mongoose.model<IPaylukJob>('PaylukJob', PaylukJobSchema);
