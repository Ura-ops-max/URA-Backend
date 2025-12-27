// models/SearchHistory.ts
import { Schema, model, Types } from 'mongoose';

const searchHistorySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  query: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export const SearchHistory = model('SearchHistory', searchHistorySchema);