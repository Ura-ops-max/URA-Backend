// backend/controllers/interactionController.ts

import { asyncHandler } from "@/middleware/errorHandler";
import { Bookmark } from "@/models/bookmark.model";
import { Comment } from "@/models/comment-model";
import { Post } from "@/models/post-model";
import { Request, Response } from 'express';

// Toggle Like on a Post
export const toggleLike = asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    const userId = req.user._id;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const isLiked = post.likes.includes(userId);

    if (isLiked) {
        // Remove like
        post.likes = post.likes.filter((id) => id.toString() !== userId.toString());
    } else {
        // Add like
        post.likes.push(userId);
    }

    await post.save();
    res.json({ success: true, isLiked: !isLiked, likesCount: post.likes.length });
});

// Toggle Bookmark (Polymorphic: can be Post or User)
export const toggleBookmark = asyncHandler(async (req: Request, res: Response) => {
    const { targetId } = req.params; // The ID of the Post or User
    const { targetType } = req.body; // 'Post' or 'User'
    const userId = req.user._id;

    const existing = await Bookmark.findOne({ user: userId, targetId });

    if (existing) {
        await Bookmark.findByIdAndDelete(existing._id);
        return res.json({ success: true, isBookmarked: false });
    }

    await Bookmark.create({
        user: userId,
        targetId,
        targetType
    });

    res.json({ success: true, isBookmarked: true });
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