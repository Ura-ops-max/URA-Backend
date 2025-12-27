// models/notification-model.ts
import { Schema, model, Types } from 'mongoose';

// models/notification-model.ts
const NotificationSchema = new Schema({
  // DYNAMIC RECIPIENT (The "Inbox" owner)
  recipient: { 
    type: Schema.Types.ObjectId, 
    refPath: 'recipientModel', 
    required: true, 
    index: true 
  },
  recipientModel: { 
    type: String, 
    enum: ['User', 'Business'], 
    required: true,
    default: 'User' 
  },

  // DYNAMIC SENDER (The "Trigger" person/entity)
  sender: { 
    type: Schema.Types.ObjectId, 
    refPath: 'senderModel', 
    required: true 
  },
  senderModel: { 
    type: String, 
    enum: ['User', 'Business'], 
    required: true,
    default: 'User' 
  },

  type: { type: String, enum: ['SECURITY', 'SOCIAL', 'BUSINESS', 'SYSTEM', 'LIKE', 'COMMENT'], required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  link: { type: String },

  relatedId: { type: Schema.Types.ObjectId, refPath: 'modelType' },
  modelType: { type: String, enum: ['Post', 'Business', 'Product', 'User', 'Comment', 'Order'] },

  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

export const Notification = model('Notification', NotificationSchema);