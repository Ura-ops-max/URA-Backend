// models/activity-model.ts
import { Schema, model } from 'mongoose';

const ActivitySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  
  // Machine-readable action name (e.g., "EMAIL_CHANGED", "PASSWORD_UPDATED")
  action: { type: String, required: true }, 
  
  // Human-readable description
  description: { type: String, required: true },

  // Metadata for security audits
  metadata: {
    ip: String,
    userAgent: String,
    device: String,
    location: String // Optional: can be derived from IP later
  },
// Soft delete flag
  isHidden: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export const Activity = model('Activity', ActivitySchema);