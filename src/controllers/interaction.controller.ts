// backend/controllers/interactionController.ts

import { asyncHandler } from "@/middleware/errorHandler";
import { Bookmark } from "@/models/bookmark.model";
import { Comment } from "@/models/comment-model";
import { Post } from "@/models/post-model";
import { Request, Response } from 'express';
import { Types } from 'mongoose'; // Added for ID casting
import { eventEmitter } from '@/services/event-emitter.services';

/**
 * Helper to safely extract user ID
 */
const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

// Toggle Like on a Post
export const toggleLike = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { postId } = req.params;
  const userId = getAuthUserId(req);

  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const post = await Post.findById(postId);
  if (!post) {
    res.status(404).json({ message: "Post not found" });
    return;
  }

  const isLiked = post.likes.some(id => id.toString() === userId);

  if (isLiked) {
    post.likes = post.likes.filter((id) => id.toString() !== userId);
  } else {
    post.likes.push(new Types.ObjectId(userId) as any);
    
    // Log activity
    eventEmitter.emit('activityLogged', {
      actorId: userId,
      actionType: 'like',
      targetModel: 'Post',
      targetId: (post._id as Types.ObjectId).toString(),
      targetOwnerId: post.author.toString(),
    });
  }

  await post.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: post.likes.length });
});

// Toggle Bookmark
export const toggleBookmark = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params; 
  const { targetType } = req.body; 
  const userId = getAuthUserId(req);

  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const existing = await Bookmark.findOne({ user: userId, targetId });

  if (existing) {
    await Bookmark.findByIdAndDelete(existing._id);
    res.json({ success: true, isBookmarked: false });
    return;
  }

  await Bookmark.create({
    user: userId,
    targetId,
    targetType
  });

  if (targetType === 'Post') {
    const post = await Post.findById(targetId).select('author');
    if (post) {
      eventEmitter.emit('activityLogged', {
        actorId: userId,
        actionType: 'bookmark',
        targetModel: 'Post',
        targetId: targetId,
        targetOwnerId: post.author.toString(),
      });
    }
  }

  res.json({ success: true, isBookmarked: true });
});

// Toggle Comment Like
export const toggleCommentLike = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { commentId } = req.params;
  const userId = getAuthUserId(req);

  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const comment = await Comment.findById(commentId);
  if (!comment) {
    res.status(404).json({ message: "Comment not found" });
    return;
  }

  const isLiked = comment.likes.some(id => id.toString() === userId);

  if (isLiked) {
    comment.likes = comment.likes.filter(id => id.toString() !== userId);
  } else {
    comment.likes.push(new Types.ObjectId(userId) as any);

    eventEmitter.emit('activityLogged', {
      actorId: userId,
      actionType: 'like',
      targetModel: 'Comment',
      targetId: (comment._id as Types.ObjectId).toString(),
      targetOwnerId: comment.author.toString(),
    });
  }

  await comment.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: comment.likes.length });
});