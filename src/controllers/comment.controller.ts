// backend/controllers/commentController.ts
import { Request, Response } from 'express';
import { Comment } from '@/models/comment-model';
import { Post } from '@/models/post-model'; 
import { asyncHandler } from '@/middleware/errorHandler';
import { trackEvent } from '@/services/track-event.service';

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
  const { content, parentId, mentions } = req.body;
  const postId = req.params.postId || req.body.postId;
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

  // LOGGING ACTIVITY & NOTIFICATION
  const targetPost = await Post.findById(postId).select('author');

  if (targetPost) {
    // 1. Log Activity for the Commenter
    await trackEvent({
        targetId: auth.userId.toString(),
        targetModel: authorType,
        type: 'ACTIVITY',
        activityData: {
            action: 'COMMENT_CREATE',
            description: `You commented on a post`,
            metadata: {contentPreview: content.substring(0, 50)}
        }
    });

    // 2. Send Notification to the Post Owner
    await trackEvent({
        targetId: targetPost.author.toString(),
        targetModel: 'User', // Post authors are stored as User IDs
        type: 'NOTIFICATION',
        notificationData: {
            type: 'COMMENT',
            title: 'New Comment',
            message: `commented on your post: "${content.substring(0, 30)}..."`,
            sender: auth.userId.toString(),
            senderModel: authorType,
            relatedId: postId,
            modelType: 'Post'
        }
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
    const authorType = auth.role === 'business' ? 'Business' : 'User';

    // 1. Log Activity for the Liker
    await trackEvent({
        targetId: auth.userId.toString(),
        targetModel: authorType,
        type: 'ACTIVITY',
        activityData: {
            action: 'COMMENT_LIKE',
            description: `You liked a comment`,
        }
    });

    // 2. Notify the Comment Author
    await trackEvent({
        targetId: comment.author.toString(),
        targetModel: 'User',
        type: 'NOTIFICATION',
        notificationData: {
            type: 'LIKE',
            title: 'New Like',
            message: `liked your comment`,
            sender: auth.userId.toString(),
            senderModel: authorType,
            relatedId: (comment._id as any).toString(),
            modelType: 'Comment'
        }
    });
  }

  await comment.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: comment.likes.length });
});