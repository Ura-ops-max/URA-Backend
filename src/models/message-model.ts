import { Schema, model, Document, Types } from 'mongoose';

/**
 * Interface for media files (Images, Videos, Voice notes)
 * These are uploaded to Cloudinary/S3 before saving to the DB.
 */
interface IMedia {
  url: string;
  type: 'image' | 'video' | 'audio' | 'file';
  fileName?: string;
}

/**
 * Interface for message reactions (Emojis)
 * Maps a specific user to a specific emoji.
 */
interface IReaction {
  user: Types.ObjectId; // Always a User ID reacting
  emoji: string;        // The emoji string (e.g., "🔥")
}

/**
 * Main Message Document Interface
 */
export interface IMessage extends Document {
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  senderModel: 'User' | 'Business'; // Dynamic reference
  content?: string;
  media?: IMedia;
  reactions: IReaction[];
  status: 'sent' | 'delivered' | 'read';
  readBy: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    // The chat room this message belongs to
    conversation: { 
      type: Schema.Types.ObjectId, 
      ref: 'Conversation', 
      required: true, 
      index: true 
    },

    // Sender logic: refPath allows Mongoose to look in 'User' or 'Business' 
    sender: { 
      type: Schema.Types.ObjectId, 
      required: true, 
      refPath: 'senderModel' 
    },
    senderModel: { 
      type: String, 
      required: true, 
      enum: ['User', 'Business'] 
    },

    // Message Body
    content: { 
      type: String, 
      trim: true 
    },

    // Media attachment
    media: {
      url: { type: String },
      type: { type: String, enum: ['image', 'video', 'audio', 'file'] },
      fileName: { type: String },
    },

    // Emoji Reactions
    reactions: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
      },
    ],

    // Message status for WhatsApp-style ticks
    status: { 
      type: String, 
      enum: ['sent', 'delivered', 'read'], 
      default: 'sent' 
    },

    // List of users who have viewed this message
    readBy: [{ 
      type: Schema.Types.ObjectId, 
      ref: 'User' 
    }],
  },
  { 
    timestamps: true, // Automatically handles createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/**
 * DATABASE INDEXING
 * 1. Find all messages in a conversation sorted by newest first (for chat history).
 * 2. Find unread messages for a specific user.
 */
messageSchema.index({ conversation: 1, createdAt: -1 });

/**
 * VALIDATION
 * A message must have either text content OR a media file. It cannot be totally empty.
 */
messageSchema.pre('validate', function (next) {
  if (!this.content && (!this.media || !this.media.url)) {
    next(new Error('Message must contain either text content or media.'));
  } else {
    next();
  }
});

export const Message = model<IMessage>('Message', messageSchema);