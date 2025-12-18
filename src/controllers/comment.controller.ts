// backend/controllers/commentController.ts
import { Request, Response } from 'express';
import { Comment } from '@/models/comment-model';
import { Post } from '@/models/post-model'; // Added Post import for logging
import { asyncHandler } from '@/middleware/errorHandler';
import { eventEmitter } from '@/services/event-emitter.services';
import { Types } from 'mongoose'; // Ensure Types is imported at the top

/**
 * Helper to safely extract user ID from the request
 */
const getAuthUser = (req: Request) => {
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;

  if (!userId) {
    return null;
  }
  return { userId, role: user.role };
};

// CREATE COMMENT
export const createComment = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { content, postId, parentId, mentions } = req.body;
  const auth = getAuthUser(req);

  if (!auth) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const authorType = auth.role === 'business' ? 'Business' : 'User';

  const comment = await Comment.create({
    content,
    author: auth.userId,
    authorType,
    postId,
    parentId: parentId || null,
    mentions: mentions || []
  });

  // LOGGING ACTIVITY
  // We need to find the post author to know who to notify
  const targetPost = await Post.findById(postId).select('author');

  if (targetPost) {
    eventEmitter.emit('activityLogged', {
      actorId: auth.userId.toString(),
      actionType: 'comment',
      targetModel: 'Post',
      targetId: postId,
      targetOwnerId: targetPost.author.toString(),
      contentPreview: content.substring(0, 50),
    });
  }

  res.status(201).json({ success: true, comment });
});

// GET COMMENTS FOR A POST
export const getComments = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { postId } = req.params;
  const auth = getAuthUser(req);
  const currentUserId = auth?.userId;

  const comments = await Comment.find({ postId, parentId: null })
    .sort({ createdAt: -1 })
    .populate({
      path: 'author',
      select: 'firstName lastName username businessName businessLogo profilePicture'
    })
    .lean();

  const formattedComments = await Promise.all(comments.map(async (comment: any) => {
    const replies = await Comment.find({ parentId: comment._id })
      .populate({
        path: 'author',
        select: 'firstName lastName username businessName businessLogo profilePicture'
      })
      .sort({ createdAt: 1 })
      .lean();

    const formattedReplies = replies.map((reply: any) => ({
      ...reply,
      isLiked: currentUserId
        ? reply.likes.some((id: any) => id.toString() === currentUserId.toString())
        : false,
      likesCount: reply.likes.length
    }));

    return {
      ...comment,
      isLiked: currentUserId
        ? comment.likes.some((id: any) => id.toString() === currentUserId.toString())
        : false,
      likesCount: comment.likes.length,
      replies: formattedReplies,
      repliesCount: formattedReplies.length
    };
  }));

  res.json({ success: true, comments: formattedComments });
});

// TOGGLE COMMENT LIKE
export const toggleCommentLike = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { commentId } = req.params;
  const auth = getAuthUser(req);

  if (!auth) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const comment = await Comment.findById(commentId);
  if (!comment) {
    res.status(404).json({ message: "Comment not found" });
    return;
  }

  const isLiked = comment.likes.some(id => id.toString() === auth.userId.toString());

  if (isLiked) {
    comment.likes = comment.likes.filter(id => id.toString() !== auth.userId.toString());
  } else {
    comment.likes.push(auth.userId);

    // Only emit activity on NEW likes
    // ... inside your toggleCommentLike function
    eventEmitter.emit('activityLogged', {
      actorId: auth.userId.toString(),
      actionType: 'like',
      targetModel: 'Comment',
      // Cast _id to any or Types.ObjectId to allow .toString()
      targetId: (comment._id as Types.ObjectId).toString(),
      targetOwnerId: comment.author.toString(),
    });
  }

  await comment.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: comment.likes.length });
});