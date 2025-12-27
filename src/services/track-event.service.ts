import { Notification } from '@/models/notification-model';
import { Activity } from '@/models/activity-model';
import { socketService } from './socket.service';

export const trackEvent = async (params: {
  // Who is receiving the notification or performing the activity
  targetId: string;
  targetModel: 'User' | 'Business' | 'Order' | 'Post' | 'Comment';

  type: 'ACTIVITY' | 'NOTIFICATION' | 'BOTH';

  notificationData?: {
    type: 'SECURITY' | 'SOCIAL' | 'BUSINESS' | 'SYSTEM' | 'COMMENT' | 'LIKE';
    title: string;
    message: string;
    link?: string;

    // Dynamic Sender
    sender: string;
    senderModel: 'User' | 'Business';

    // Dynamic Related Object
    relatedId?: string;
    modelType?: 'Post' | 'Business' | 'Product' | 'User' | 'Order' | 'Comment';
  };

  activityData?: {
    action: string;
    description: string;
    metadata?: {
      ip?: string | undefined;        // Add | undefined here
      userAgent?: string | undefined; // Add | undefined here
      device?: string | undefined;
      location?: string | undefined;
      contentPreview?: string;
    };
  };
}) => {
  const { targetId, targetModel, type, notificationData, activityData } = params;

  // 1. Handle Activity Log
  // Note: Activity is usually logged for the person performing the action
  if ((type === 'ACTIVITY' || type === 'BOTH') && activityData) {
    await Activity.create({
      user: targetId,
      action: activityData.action,
      description: activityData.description,
      metadata: activityData.metadata
      // If activities also need a 'userModel' in the future, we can add it here
    });
  }

  // 2. Handle Notification
  if ((type === 'NOTIFICATION' || type === 'BOTH') && notificationData) {
    const newNotification = await Notification.create({
      recipient: targetId,
      recipientModel: targetModel, // Dynamic Recipient
      ...notificationData
    });

    // 3. Send via Socket if target (User or Business) is online
    // This works because your socket.on('setup') handles the ID string
    if (socketService.isOnline(targetId)) {
      socketService.sendNotification(targetId, newNotification);
    }
  }
};