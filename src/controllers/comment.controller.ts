// backend/controllers/commentController.ts
import { Request, Response } from 'express';
import { Comment } from '@/models/comment-model';
import { asyncHandler } from '@/middleware/errorHandler';

// CREATE COMMENT
export const createComment = asyncHandler(async (req: Request, res: Response) => {
  const { content, postId, parentId, mentions } = req.body;
  const authorId = req.user._id;
  const authorType = req.user.role === 'business' ? 'Business' : 'User'; // Adjust based on your Auth logic

  const comment = await Comment.create({
    content,
    author: authorId,
    authorType,
    postId,
    parentId: parentId || null,
    mentions: mentions || []
  });

  res.status(201).json({ success: true, comment });
});

// GET COMMENTS FOR A POST
export const getComments = asyncHandler(async (req: Request, res: Response) => {
  const { postId } = req.params;
  const currentUserId = req.user?._id;

  const comments = await Comment.find({ postId, parentId: null })
    .sort({ createdAt: -1 })
    .populate({
      path: 'author',
      select: 'firstName lastName username businessName businessLogo profilePicture'
    })
    .lean();

  const formattedComments = await Promise.all(comments.map(async (comment: any) => {
    // 1. Fetch replies
    const replies = await Comment.find({ parentId: comment._id })
      .populate({
        path: 'author',
        select: 'firstName lastName username businessName businessLogo profilePicture'
      })
      .sort({ createdAt: 1 })
      .lean();

    // 2. Format REPLIES specifically to include isLiked and likesCount
    const formattedReplies = replies.map((reply: any) => ({
      ...reply,
      isLiked: currentUserId 
        ? reply.likes.some((id: any) => id.toString() === currentUserId.toString()) 
        : false,
      likesCount: reply.likes.length
    }));

    // 3. Format PARENT comment
    return {
      ...comment,
      isLiked: currentUserId 
        ? comment.likes.some((id: any) => id.toString() === currentUserId.toString()) 
        : false,
      likesCount: comment.likes.length,
      replies: formattedReplies, // Use the formatted ones!
      repliesCount: formattedReplies.length 
    };
  }));

  res.json({ success: true, comments: formattedComments });
});


export const toggleCommentLike = asyncHandler(async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const userId = req.user._id;

  const comment = await Comment.findById(commentId);
  if (!comment) return res.status(404).json({ message: "Comment not found" });

  const isLiked = comment.likes.some(id => id.toString() === userId.toString());

  if (isLiked) {
    comment.likes = comment.likes.filter(id => id.toString() !== userId.toString());
  } else {
    comment.likes.push(userId);
  }

  await comment.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: comment.likes.length });
});