import { Request, Response } from 'express';
import { Conversation } from "@/models/conversation-model";
import { Message } from "@/models/message-model";
import { Business } from '@/models/business-model';
import { Types } from 'mongoose';
import { trackEvent } from '@/services/track-event.service'; // Added import

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

export const accessConversation = async (req: Request, res: Response) => {
  try {
    const { senderId, senderModel, receiverId, receiverModel } = req.body;
    const authenticatedUserId = getAuthUserId(req); 
    
    if (!receiverId || !senderId) {
       res.status(400).json({ success: false, message: "Participant IDs are required" });
    }

    if (senderModel === 'User') {
      if (senderId !== authenticatedUserId) {
         res.status(403).json({ success: false, message: "Unauthorized: You cannot impersonate this user." });
      }
    } else if (senderModel === 'Business') {
      const business = await Business.findOne({ _id: senderId, owner: authenticatedUserId });
      if (!business) {
         res.status(403).json({ success: false, message: "Unauthorized: You do not own this business account." });
      }
    }

    let conversation = await Conversation.findOne({
      participants: {
        $all: [
          { $elemMatch: { participantId: senderId, participantModel: senderModel } },
          { $elemMatch: { participantId: receiverId, participantModel: receiverModel } }
        ]
      }
    })
      .populate('lastMessage')
      .populate('participants.participantId');

    if (conversation) {
       res.status(200).json({ success: true, data: conversation });
    }

    const unreadMap = new Map();
    unreadMap.set(senderId.toString(), 0);
    unreadMap.set(receiverId.toString(), 0);

    const visibilityMap = new Map();
    visibilityMap.set(senderId.toString(), true);
    visibilityMap.set(receiverId.toString(), true);

    const newConversation = await Conversation.create({
      participants: [
        { participantId: senderId, participantModel: senderModel },
        { participantId: receiverId, participantModel: receiverModel }
      ],
      unreadCount: unreadMap,
      visibleTo: visibilityMap
    });

    // 🚨 TRACK EVENT: Log that a conversation was initiated
    await trackEvent({
        targetId: senderId,
        targetModel: senderModel as any,
        type: 'ACTIVITY',
        activityData: {
            action: 'CHAT_INITIATED',
            description: `You started a conversation with a ${receiverModel}`,
        }
    });

    const populatedChat = await Conversation.findById(newConversation._id)
      .populate('participants.participantId');

     res.status(201).json({ success: true, data: populatedChat });

  } catch (error: any) {
    console.error("Access Conversation Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getConversations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { profileId } = req.query;
    const authenticatedUserId = getAuthUserId(req);

    if (!profileId) {
       res.status(400).json({ success: false, message: "Profile ID is required" });
    }

    const isOwner = profileId === authenticatedUserId;
    const ownsBusiness = await Business.exists({ _id: profileId, owner: authenticatedUserId });

    if (!isOwner && !ownsBusiness) {
       res.status(403).json({ success: false, message: "Unauthorized access to this profile's chats." });
    }

    const conversations = await Conversation.find({
      "participants.participantId": profileId,
      [`visibleTo.${profileId}`]: { $ne: false } 
    })
      .populate({
        path: 'participants.participantId',
        select: 'firstName lastName businessName profilePicture businessLogo'
      })
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    res.status(200).json({ success: true, data: conversations });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { conversationId } = req.params;
    const { profileId } = req.query; 
    const authenticatedUserId = getAuthUserId(req);

    if (!profileId) {
       res.status(400).json({ success: false, message: "Profile ID is required" });
    }

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
       res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const isParticipant = conversation?.participants.some(
      p => p.participantId.toString() === profileId
    );

    const isOwner = profileId === authenticatedUserId ||
      await Business.exists({ _id: profileId, owner: authenticatedUserId });

    if (!isParticipant || !isOwner) {
       res.status(403).json({ success: false, message: "Unauthorized access to these messages." });
    }

    const messages = await Message.find({ conversation: conversationId })
      .populate('sender', 'firstName lastName businessName profilePicture businessLogo')
      .sort({ createdAt: 1 });

    const currentUnread = conversation?.unreadCount.get(profileId as string) ?? 0;

    if (currentUnread !== null || currentUnread  > 0) {
      conversation?.unreadCount.set(profileId as string, 0);
      await conversation?.save();

      await Message.updateMany(
        {
          conversation: conversationId,
          sender: { $ne: profileId },
          status: { $ne: 'seen' }
        },
        { $set: { status: 'seen' } }
      );

      const io = req.app.get('io');
      if (io) {
        io.to(conversationId).emit('messages_seen', { conversationId, seenBy: profileId });
      }
    }

    res.status(200).json({ success: true, data: messages });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const sendMessage = async (req: Request, res: Response):Promise<void> => {
  try {
    const { conversationId, content, senderId, senderModel, media } = req.body;
    const authenticatedUserId = getAuthUserId(req);

    const isUser = senderId === authenticatedUserId;
    const ownsBusiness = await Business.exists({ _id: senderId, owner: authenticatedUserId });

    if (!isUser && !ownsBusiness) {
       res.status(403).json({ success: false, message: "Unauthorized sender identity." });
       return
    }

    const newMessage = await Message.create({
      conversation: conversationId,
      sender: senderId,
      senderModel: senderModel,
      content,
      media,
      status: 'sent'
    });

    const conversation = await Conversation.findById(conversationId);
    if (!conversation)  res.status(404).json({ message: "Chat not found" });

    const receiver = conversation?.participants.find(
      p => p.participantId.toString() !== senderId
    );

    if (receiver) {
      const receiverId = receiver.participantId.toString();
      const currentUnread = conversation?.unreadCount.get(receiverId) ?? 0;
      conversation?.unreadCount.set(receiverId, currentUnread + 1);

      // 🚨 TRACK EVENT: Notify Receiver (Internal System Notification)
      // This ensures even if they aren't on the chat screen, they get a global notification
      await trackEvent({
          targetId: receiverId,
          targetModel: receiver.participantModel as any,
          type: 'NOTIFICATION',
          notificationData: {
              type: 'SOCIAL', // Messaging falls under Social
              title: 'New Message',
              message: content ? content.substring(0, 50) : 'Sent a photo',
              sender: senderId,
              senderModel: senderModel as any,
              relatedId: conversationId,
              modelType: 'User' // Conversations don't have a modelType in your trackEvent, usually mapped to User context
          }
      });
    }

    if (conversation) {
      conversation.lastMessage = newMessage._id as Types.ObjectId;
      conversation.visibleTo.set(senderId, true);
      if (receiver) conversation.visibleTo.set(receiver.participantId.toString(), true);
      await conversation.save();
    }

    const populatedMessage = await newMessage.populate('sender', 'firstName lastName businessName profilePicture businessLogo');
    const io = req.app.get('io');
    if (io) {
      io.to(conversationId).emit('message:received', populatedMessage);
      const receiverId = receiver?.participantId.toString();
      if (receiverId) {
        io.to(receiverId).emit('new_notification', {
          type: 'MESSAGE',
          conversationId: conversationId,
          unreadCount: conversation?.unreadCount.get(receiverId)
        });
      }
    }
    res.status(201).json({ success: true, data: populatedMessage });

  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};