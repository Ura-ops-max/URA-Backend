import { Request, Response, NextFunction } from 'express';
import { Activity } from '@/models/activity-model';
import { asyncHandler } from '@/middleware/errorHandler';
import { Types } from 'mongoose';

/**
 * Get the activity feed for the logged-in user.
 */
export const getActivityList = asyncHandler(async (req: Request, res: Response) => {
  // 1. Get current user ID (assuming req.user is set by your auth middleware)
  const userId = (req as any).user.id;
  const userIdObj = new Types.ObjectId(userId);

  const activities = await Activity.find({
    targetOwner: userIdObj,
    actor: { $ne: userIdObj }
  })
    .sort({ createdAt: -1 }) // Newest first
    .limit(20)
    .populate('actor', 'username profilePicture firstName lastName');

  // 3. Map to the frontend structure
  const activityList = activities.map((act: any) => {
    // Determine the action text based on actionType
    const actionLabel = getActionLabel(act.actionType, act.targetModel);

    return {
      id: act._id.toString(),
      name: act.actor?.username || 'Someone',
      action: actionLabel,
      time: act.createdAt.toISOString(),
      avatar: act.actor?.profilePicture || `https://ui-avatars.com/api/?name=${act.actor?.username || 'U'}`
    };
  });

  res.status(200).json({
    success: true,
    activities: activityList
  });
});

/**
 * Helper to turn database types into friendly strings
 */
function getActionLabel(type: string, model: string): string {
  const labels: Record<string, string> = {
    like: `liked your ${model.toLowerCase()}`,
    comment: `commented on your ${model.toLowerCase()}`,
    share: `shared your ${model.toLowerCase()}`,
    bookmark: `bookmarked your ${model.toLowerCase()}`,
    follow: `started following you`,
  };
  return labels[type] || `interacted with your ${model.toLowerCase()}`;
}