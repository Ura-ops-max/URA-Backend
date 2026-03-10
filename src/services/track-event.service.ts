import { Notification } from '@/models/notification-model';
import { Activity } from '@/models/activity-model';
import { socketService } from './socket.service';

export const trackEvent = async (params: {
  targetId: string;
  targetModel: string;
  type: 'ACTIVITY' | 'NOTIFICATION' | 'BOTH';
  activityData: {
    action: string;
    description: string;
   metadata?: Record<any, any>
  };
  notificationData?: {
    type: string;
    title: string;
    message: `Order ${any} has been paid.`;
    sender: string;
    senderModel: string;
    relatedId: string;
    modelType: string
  }
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