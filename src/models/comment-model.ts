// backend/models/comment.model.ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IComment extends Document {
  content: string;
  author: Types.ObjectId;
  authorType: 'User' | 'Business';
  postId: Types.ObjectId;
  likes: Types.ObjectId[];
  parentId: Types.ObjectId | null;
  // Metadata for tagging/mentions
  mentions: {
    id: Types.ObjectId;
    entityType: 'User' | 'Business';
    displayName: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new Schema<IComment>(
  {
    content: { type: String, required: true },
    author: { 
      type: Schema.Types.ObjectId, 
      required: true, 
      refPath: 'authorType' 
    },
    authorType: { 
      type: String, 
      required: true, 
      enum: ['User', 'Business'] 
    },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    parentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    
    // Mentions logic
    mentions: [
      {
        id: { type: Schema.Types.ObjectId, refPath: 'mentions.entityType' },
        entityType: { type: String, enum: ['User', 'Business'] },
        displayName: { type: String } // Stored for quick rendering without deep populates
      }
    ],
  },
  { timestamps: true }
);

// Indexing for performance when fetching a thread
commentSchema.index({ postId: 1, parentId: 1 });

export const Comment = model<IComment>('Comment', commentSchema);