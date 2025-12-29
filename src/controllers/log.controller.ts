import { Request, Response } from 'express';
import { Notification } from '@/models/notification-model';
import { Business } from '@/models/business-model';
import { asyncHandler } from '@/middleware/errorHandler';
import { Types } from 'mongoose';
import { Activity } from '@/models/activity-model';

/**
 * Helper to get all IDs associated with a user (Self + Owned Businesses)
 */
const getRecipientIds = async (req: Request) => {
  const userId = (req as any).user._id;
  const userBusinesses = await Business.find({ owner: userId }).select('_id');
  return [userId, ...userBusinesses.map(b => b._id)];
};

export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const allRecipientIds = await getRecipientIds(req);

  const notifications = await Notification.find({ 
    recipient: { $in: allRecipientIds } 
  })
    .sort({ createdAt: -1 })
    .populate('sender', 'firstName lastName username profilePicture businessName businessLogo')
    .populate('relatedId')
    .lean();

  res.status(200).json(notifications);
});

export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params; // For single ID via URL
  const { ids } = req.body;   // For bulk selection via Body
  const allRecipientIds = await getRecipientIds(req);

  let query: any = { recipient: { $in: allRecipientIds }, isRead: false };

  // 1. Handle Bulk Selection from Desktop Checkboxes
  if (ids && Array.isArray(ids)) {
    query._id = { $in: ids };
  } 
  // 2. Handle Single Click
  else if (id) {
    query._id = id;
  }
  // 3. If no ID/IDs provided, "Mark All As Read" logic applies

  await Notification.updateMany(query, { $set: { isRead: true } });

  res.status(200).json({ success: true });
});

export const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ids } = req.body; // Support for bulk delete
  const allRecipientIds = await getRecipientIds(req);

  let query: any = { recipient: { $in: allRecipientIds } };

  if (ids && Array.isArray(ids)) {
    query._id = { $in: ids };
  } else {
    query._id = id;
  }

  const result = await Notification.deleteMany(query);

  res.status(200).json({ 
    success: true, 
    message: `${result.deletedCount} notification(s) deleted` 
  });
});

export const clearAllNotifications = asyncHandler(async (req: Request, res: Response) => {
  const allRecipientIds = await getRecipientIds(req);

  await Notification.deleteMany({ 
    recipient: { $in: allRecipientIds } 
  });

  res.status(200).json({ success: true, message: "All notifications cleared" });
});

export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const allRecipientIds = await getRecipientIds(req);

  const count = await Notification.countDocuments({
    recipient: { $in: allRecipientIds },
    isRead: false
  });

  res.status(200).json({ count });
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