import { Notification } from '@/models/notification-model';
import { Activity } from '@/models/activity-model';
import { socketService } from './socket.service';
import { sendPushToUser } from './push.service';

type ActivityData = {
  action: string;
  description: string;
  metadata?: Record<any, any>;
};

type NotificationData = {
  type: string;
  title: string;
  message: string;
  /** One line for the pop-up and push; the message is used when missing. */
  summary?: string;
  sender: string;
  senderModel: string;
  relatedId?: string;
  modelType?: string;
};

export type TrackEventParams =
  | {
      targetId: string;
      targetModel: string;
      type: 'ACTIVITY';
      activityData: ActivityData;
      notificationData?: never;
    }
  | {
      targetId: string;
      targetModel: string;
      type: 'NOTIFICATION';
      notificationData: NotificationData;
      activityData?: never;
    }
  | {
      targetId: string;
      targetModel: string;
      type: 'BOTH';
      activityData: ActivityData;
      notificationData: NotificationData;
    };

export const trackEvent = async (params: TrackEventParams) => {
  const { targetId, targetModel, type } = params;

  if ((type === 'ACTIVITY' || type === 'BOTH') && params.activityData) {
    await Activity.create({
      user: targetId,
      action: params.activityData.action,
      description: params.activityData.description,
      metadata: params.activityData.metadata,
    });
  }

  if ((type === 'NOTIFICATION' || type === 'BOTH') && params.notificationData) {
    const newNotification = await Notification.create({
      recipient: targetId,
      recipientModel: targetModel,
      ...params.notificationData,
    });

    if (socketService.isOnline(targetId)) {
      socketService.sendNotification(targetId, newNotification);
    }

    // Web push for order notices, so people hear about them with URA closed.
    // Same words as the in-app pop-up. Users only (push is per person).
    const n = params.notificationData;
    if (n.modelType === 'Order' && targetModel === 'User' && n.relatedId) {
      sendPushToUser(String(targetId), {
        title: n.title,
        body: n.summary ?? n.message,
        url: `/dashboard/orders/${n.relatedId}`,
      }).catch(e => console.error('[push] order notice failed:', (e as Error).message));
    }
  }
};
