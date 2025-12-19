// backend/controllers/interactionController.ts

import { asyncHandler } from "@/middleware/errorHandler";
import { Bookmark } from "@/models/bookmark.model";
import { Comment } from "@/models/comment-model";
import { Post } from "@/models/post-model";
import { Request, Response } from 'express';
import { Types } from 'mongoose'; // Added for ID casting
import { eventEmitter } from '@/services/event-emitter.services';
import { Business } from "@/models/business-model";
import { User } from "@/models/user-model";

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



export const toggleBookmark = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params;
  const { targetType } = req.body; // 'Post' or 'Business'
  const userId = (req as any).user?._id;

  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  // 1. Setup based on type
  const isPost = targetType === 'Post';
  const bookmarkField = isPost ? 'bookmarkedPosts' : 'bookmarkedBusinesses';

  if (targetType !== 'Business' && !isPost) {
    res.status(400).json({ message: "Invalid target type" });
    return;
  }

  // 2. Check if already bookmarked
  const user = await User.findById(userId).select(bookmarkField);
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  const isAlreadyBookmarked = (user[bookmarkField] as Types.ObjectId[]).some(
    (id) => id.toString() === targetId
  );

  if (isAlreadyBookmarked) {
    // --- REMOVE ---
    await User.findByIdAndUpdate(userId, { $pull: { [bookmarkField]: targetId } });
    res.json({ success: true, isBookmarked: false });
  } else {
    // --- ADD ---
    let targetOwnerId: string | undefined;

    // Validation & Data Fetching
    if (isPost) {
      const post = await Post.findById(targetId).select('author');
      if (!post) {
        res.status(404).json({ message: "Post not found" });
        return;
      }
      targetOwnerId = post.author.toString();
    } else {
      const businessExists = await Business.exists({ _id: targetId });
      if (!businessExists) {
        res.status(404).json({ message: "Business not found" });
        return;
      }
    }

    // Atomic Update
    await User.findByIdAndUpdate(userId, { $addToSet: { [bookmarkField]: targetId } });

    // Activity Logging (Post only)
    if (isPost && targetOwnerId) {
      eventEmitter.emit('activityLogged', {
        actorId: userId,
        actionType: 'bookmark',
        targetModel: 'Post',
        targetId,
        targetOwnerId,
      });
    }

    res.json({ success: true, isBookmarked: true });
  }
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



export const toggleFollow = asyncHandler(async (req: Request, res: Response): Promise<void> => {

  try {
    const { targetId } = req.params;
    const { isBusiness } = req.body; // Pass this from the frontend
    const userId = getAuthUserId(req);

    if (!userId) {
      res.status(401).json({ message: "User not authenticated" });
      return;
    }

    if (targetId === userId) {
      res.status(400).json({ message: "You cannot follow yourself" });
      return;
    }

    const followerArray = isBusiness ? "followingBusinesses" : "followingUsers";

    // Find the user to check their current status
    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ message: "user not found" });
      return;
    }


    // 1. Validate if the string is a valid ObjectId first (prevents crashing)
    if (!Types.ObjectId.isValid(targetId)) {
      res.status(400).json({ message: "Invalid ID format" });
      return
    }

    // 2. Convert string to ObjectId for the comparison
    const targetObjectId = new Types.ObjectId(targetId);

    // 3. Perform the check
    const isAlreadyFollowing = user[followerArray].includes(targetObjectId);

    if (isAlreadyFollowing) {
      // --- UNFOLLOW LOGIC ---
      await User.findByIdAndUpdate(userId, { $pull: { [followerArray]: targetId } });

      if (isBusiness) {
        await Business.findByIdAndUpdate(targetId, { $pull: { followers: userId } });
      } else {
        await User.findByIdAndUpdate(targetId, { $pull: { followers: userId } });
      }

      res.status(200).json({ message: "Unfollowed", isFollowing: false });
      return
    } else {
      // --- FOLLOW LOGIC ---
      await User.findByIdAndUpdate(userId, { $push: { [followerArray]: targetId } });

      if (isBusiness) {
        await Business.findByIdAndUpdate(targetId, { $push: { followers: userId } });
      } else {
        await User.findByIdAndUpdate(targetId, { $push: { followers: userId } });
      }

      res.status(200).json({ message: "Followed", isFollowing: true });
      return
    }
  } catch (error: any) {
    res.status(500).json({ message: "Server error", error: error.message });
    return
  }
});
