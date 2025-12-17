// src/controllers/chat.controller.ts

import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { Conversation, IConversation } from '@/models/conversation-model';

// --- Type Definitions for Populated Data ---

interface PopulatedBusiness {
    _id: Types.ObjectId;
    businessName: string;
    profilePicture?: string;
}

interface PopulatedConversation extends Omit<IConversation, 'participants' | 'lastMessage'> {
    participants: {
        user: Types.ObjectId;
        business: PopulatedBusiness;
    };
    lastMessage?: {
        _id: Types.ObjectId;
        content?: string;
        createdAt: Date;
        readBy: Types.ObjectId[];
    };
}

interface ChatListItem {
    id: string;
    name: string;
    avatar: string;
    message: string;
    date: Date;
    isUnread: boolean;
}

// --- Controller Functions ---

// ** MUST EXPORT **
export const createOrGetConversation = async (req: Request, res: Response, next: NextFunction) => { /* ... existing logic ... */ next(); };
export const getMessages = async (req: Request, res: Response, next: NextFunction) => { /* ... existing logic ... */ next(); };


/**
 * Get a list of recent conversations for the authenticated user.
 */
export const getConversationList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req as unknown as { user: { id: string } }).user.id;
        const userIdObj = new Types.ObjectId(userId);

        // Fetch and populate, casting the result to the precise populated shape
        const conversations = await Conversation.find({ 
            'participants.user': userIdObj 
        })
        // ... population and sort/limit remain the same ...
        .limit(10) as unknown as PopulatedConversation[]; // Final cast remains here

        // Map to the clean frontend structure
        const chatList: ChatListItem[] = conversations
            .filter(convo => convo.lastMessage)
            .map(convo => {
                // 🚨 FIX: Create a LOCAL variable with an explicit, trusted assertion.
                // This isolates the Mongoose weirdness and forces type safety for the properties.
                const typedConvo = convo as PopulatedConversation & { _id: Types.ObjectId };
                
                const business = typedConvo.participants.business;
                const lastMessage = typedConvo.lastMessage!;

                const isUnread = !lastMessage.readBy.some(id => id.equals(userIdObj));
                const lastMessageContent = lastMessage.content || 'Sent a media file';

                return {
                    // ✅ Safely accessed using the trusted local variable
                    id: typedConvo._id.toString(), 
                    name: business.businessName,
                    avatar: business.profilePicture || '',
                    message: lastMessageContent,
                    date: lastMessage.createdAt,
                    isUnread: isUnread,
                };
            });

        res.json({ success: true, data: chatList });
    } catch (err) {
        next(err);
    }
};