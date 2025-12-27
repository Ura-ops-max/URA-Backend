import { Request, Response } from 'express';
import { Notification } from '@/models/notification-model';
import { Activity } from '@/models/activity-model';
import { asyncHandler } from '@/middleware/errorHandler';

// --- NOTIFICATIONS ---

import { Business } from '@/models/business-model';

export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  // 1. Find all businesses owned by this user
  const userBusinesses = await Business.find({ owner: userId }).select('_id');
  const businessIds = userBusinesses.map(b => b._id);

  // 2. Create an array of all recipient IDs the user cares about
  const allRecipientIds = [userId, ...businessIds];

  // 3. Fetch notifications for any of these recipients
  const notifications = await Notification.find({ 
    recipient: { $in: allRecipientIds } 
  })
    .sort({ createdAt: -1 })
    .populate('sender')    // This will pull User profilePic or Business logo
    .populate('relatedId'); // This will pull Post/Product/Business details

  res.status(200).json(notifications);
});

export const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user._id;

  // Find businesses to ensure we can delete business-related notifications too
  const userBusinesses = await Business.find({ owner: userId }).select('_id');
  const allRecipientIds = [userId, ...userBusinesses.map(b => b._id)];

  await Notification.findOneAndDelete({ 
    _id: id, 
    recipient: { $in: allRecipientIds } 
  });

  res.status(200).json({ success: true, message: "Notification deleted" });
});

export const clearAllNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const userBusinesses = await Business.find({ owner: userId }).select('_id');
  const allRecipientIds = [userId, ...userBusinesses.map(b => b._id)];

  await Notification.deleteMany({ 
    recipient: { $in: allRecipientIds } 
  });

  res.status(200).json({ success: true, message: "All notifications cleared" });
});

// controllers/notification.controller.ts

export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  // 1. Fetch businesses only if the user is a business owner (Optimization)
  let allRecipientIds = [userId];
  
  if ((req as any).user.isBusinessOwner) {
    const userBusinesses = await Business.find({ owner: userId }).select('_id');
    const businessIds = userBusinesses.map(b => b._id);
    allRecipientIds = [userId, ...businessIds];
  }

  // 2. Count unread notifications for all relevant IDs
  const count = await Notification.countDocuments({
    recipient: { $in: allRecipientIds },
    isRead: false
  });

  res.status(200).json({ count });
});

export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user._id;

  let allRecipientIds = [userId];
  if ((req as any).user.isBusinessOwner) {
    const userBusinesses = await Business.find({ owner: userId }).select('_id');
    allRecipientIds = [userId, ...userBusinesses.map(b => b._id)];
  }

  if (id) {
    // Mark one specific notification
    await Notification.findOneAndUpdate(
      { _id: id, recipient: { $in: allRecipientIds } },
      { isRead: true }
    );
  } else {
    // Mark all as read
    await Notification.updateMany(
      { recipient: { $in: allRecipientIds }, isRead: false },
      { $set: { isRead: true } }
    );
  }

  res.status(200).json({ success: true });
});
// --- ACTIVITIES ---

// controllers/log.controller.ts

// Fetch only activities the user hasn't "cleared"
export const getActivities = asyncHandler(async (req: Request, res: Response) => {
  const activities = await Activity.find({ 
    user: (req as any).user._id,
    isHidden: false // Only show visible ones
  })
  .sort({ createdAt: -1 });
  
  res.status(200).json(activities);
});

// Soft delete: Mark all current activities as hidden
export const clearAllActivities = asyncHandler(async (req: Request, res: Response) => {
  await Activity.updateMany(
    { user: (req as any).user._id, isHidden: false },
    { $set: { isHidden: true } }
  );
  
  res.status(200).json({ 
    success: true, 
    message: "Activity history cleared from view" 
  });
});