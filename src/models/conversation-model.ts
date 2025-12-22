import { Schema, model, Document, Types } from 'mongoose';

export interface IConversation extends Document {
  participants: {
    user: Types.ObjectId;
    business: Types.ObjectId;
  };
  lastMessage?: Types.ObjectId; // For the sidebar preview (content + time)
  unreadCount: {
    user: number;      // Unread messages for the User
    business: number;  // Unread messages for the Business
  };
  // Allows users to "delete" a chat from their view without deleting the actual data
  visibleTo: {
    user: boolean;
    business: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      user: { 
        type: Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
      },
      business: { 
        type: Schema.Types.ObjectId, 
        ref: 'Business', 
        required: true,
        index: true 
      },
    },
    lastMessage: { 
      type: Schema.Types.ObjectId, 
      ref: 'Message' 
    },
    unreadCount: {
      user: { type: Number, default: 0 },
      business: { type: Number, default: 0 },
    },
    visibleTo: {
      user: { type: Boolean, default: true },
      business: { type: Boolean, default: true },
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/**
 * INDEXING
 * 1. Ensure only ONE conversation exists between a specific user and business.
 * 2. Optimized sorting for the chat list (usually sorted by updatedAt).
 */
conversationSchema.index(
  { 'participants.user': 1, 'participants.business': 1 }, 
  { unique: true }
);
conversationSchema.index({ updatedAt: -1 });

export const Conversation = model<IConversation>('Conversation', conversationSchema);