import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IBookmark extends Document {
  user: Types.ObjectId;      // The person who is bookmarking
  targetId: Types.ObjectId;  // The ID of the Post OR User being bookmarked
  targetType: 'Post' | 'User'; 
  createdAt: Date;
}

const BookmarkSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  targetId: { 
    type: Schema.Types.ObjectId, 
    required: true, 
    refPath: 'targetType' // 🚨 This makes it polymorphic
  },
  targetType: { 
    type: String, 
    required: true, 
    enum: ['Post', 'User'] 
  },
  createdAt: { type: Date, default: Date.now }
});

// Unique index: A user can bookmark a specific target only once
BookmarkSchema.index({ user: 1, targetId: 1 }, { unique: true });

export const Bookmark = mongoose.model<IBookmark>('Bookmark', BookmarkSchema);