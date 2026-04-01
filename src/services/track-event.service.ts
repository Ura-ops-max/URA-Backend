import { Notification } from '@/models/notification-model';
import { Activity } from '@/models/activity-model';
import { socketService } from './socket.service';

type ActivityData = {
  action: string;
  description: string;
  metadata?: Record<any, any>;
};

type NotificationData = {
  type: string;
  title: string;
  message: string;
  sender: string;
  senderModel: string;
  relatedId?: string;
  modelType?: string;
};

export type TrackEventParams =
    | { targetId: string; targetModel: string; type: 'ACTIVITY'; activityData: ActivityData; notificationData?: never }
    | { targetId: string; targetModel: string; type: 'NOTIFICATION'; notificationData: NotificationData; activityData?: never }
    | { targetId: string; targetModel: string; type: 'BOTH'; activityData: ActivityData; notificationData: NotificationData };

export const trackEvent = async (params: TrackEventParams) => {
  const { targetId, targetModel, type } = params;

  if ((type === 'ACTIVITY' || type === 'BOTH') && params.activityData) {
    await Activity.create({
      user: targetId,
      action: params.activityData.action,
      description: params.activityData.description,
      metadata: params.activityData.metadata
    });
  }

  if ((type === 'NOTIFICATION' || type === 'BOTH') && params.notificationData) {
    const newNotification = await Notification.create({
      recipient: targetId,
      recipientModel: targetModel,
      ...params.notificationData
    });

    if (socketService.isOnline(targetId)) {
      socketService.sendNotification(targetId, newNotification);
    }
  }
};