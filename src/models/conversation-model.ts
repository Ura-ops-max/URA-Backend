import { Schema, model, Document, Types } from 'mongoose';

export interface IParticipant {
  participantId: Types.ObjectId;
  participantModel: 'User' | 'Business';
}

export interface IConversation extends Document {
  participants: IParticipant[];
  lastMessage?: Types.ObjectId;
  // Use Map for dynamic keys (participantId) to handle unread/visibility
  unreadCount: Map<string, number>; 
  visibleTo: Map<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    participants: [
      {
        participantId: {
          type: Schema.Types.ObjectId,
          required: true,
          refPath: 'participants.participantModel',
        },
        participantModel: {
          type: String,
          required: true,
          enum: ['User', 'Business'],
        },
      },
    ],
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
    },
    // Map allows us to do: unreadCount.set(userId, 5)
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
    visibleTo: {
      type: Map,
      of: Boolean,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// This index ensures we don't have duplicate chats between the same two entities
// Note: You'll need to sort participant IDs before saving to make this unique index effective
// Replace your current index with this:
conversationSchema.index(
  { 
    'participants.participantId': 1, 
    'participants.participantModel': 1 
  }
);
conversationSchema.index({ updatedAt: -1 });

export const Conversation = model<IConversation>('Conversation', conversationSchema);