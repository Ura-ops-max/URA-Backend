import mongoose, { Document, Schema, Types } from 'mongoose';

// Defines the structure of the data the frontend expects
interface IActivity extends Document {
    actor: Types.ObjectId; // The user who performed the action (Liker, Commenter, Sharer)
    actionType: 'like' | 'comment' | 'share' | 'bookmark' | 'follow' | 'signup'; // The type of action
    targetModel: 'Post' | 'User' | 'Comment'; // The type of document the action was performed ON
    targetId: Types.ObjectId; // The ID of the document the action was performed ON (e.g., Post ID)
    targetOwner?: Types.ObjectId; // The owner of the target (e.g., the author of the Post)
    contentPreview?: string; // A short preview of the content (e.g., first 50 chars of a comment)
    createdAt: Date;
}

const ActivitySchema: Schema = new Schema({
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actionType: { type: String, required: true },
    targetModel: { type: String, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true, index: true },
    targetOwner: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    contentPreview: { type: String, maxlength: 100 },
    // Mongoose automatically adds createdAt, but explicitly define it for clarity
    createdAt: { type: Date, default: Date.now, index: true }
});

export const Activity = mongoose.model<IActivity>('Activity', ActivitySchema);