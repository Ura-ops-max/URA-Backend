
import { Request, Response } from 'express';
import { User } from '@/models/user-model';
import { asyncHandler } from '@/middleware/errorHandler';
import { Types } from 'mongoose';
import { Review } from '@/models/review-model';
import { Comment } from '@/models/comment-model';

export const getMyBookmarks = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { type } = req.query; // 'Post' or 'Business'
  const currentUserId = (req as any).user?._id;

  if (!currentUserId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const isPostRequest = type === 'Post';
  const bookmarkField = isPostRequest ? 'bookmarkedPosts' : 'bookmarkedBusinesses';

  // 1. Fetch User with bookmarks populated
  const userWithBookmarks = await User.findById(currentUserId)
    .populate({
      path: bookmarkField,
      populate: isPostRequest ? [
        { 
          path: 'author', 
          select: '_id username businessName firstName lastName profilePicture businessLogo isVerified' 
        },
        { path: 'product' }
      ] : []
    })
    .lean();

  if (!userWithBookmarks) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  const rawResults = (userWithBookmarks as any)[bookmarkField] || [];

  // 2. If it's a Business bookmark, return simple formatting
  if (!isPostRequest) {
    const formattedBusinesses = rawResults.map((item: any) => ({
      ...item,
      isBookmarked: true
    }));
    res.status(200).json(formattedBusinesses);
    return;
  }

  // 3. If it's a POST bookmark, apply full FEED logic (Likes, Reviews, Comments)
  const formattedPosts = await Promise.all(rawResults.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';
    const hasProduct = !!post.product;

    // Fetch Rating Data for Business Authors
    let ratingData = { average: 0, count: 0 };
    if (isBusiness && author?._id) {
      const reviews = await Review.aggregate([
        { $match: { reviewedItem: new Types.ObjectId(author._id) } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            count: { $sum: 1 }
          }
        }
      ]);
      if (reviews.length > 0) {
        ratingData = {
          average: Math.round(reviews[0].avgRating * 10) / 10,
          count: reviews[0].count
        };
      }
    }

    // Interaction Counts
    const isLiked = post.likes ? post.likes.some((id: any) => id.toString() === currentUserId.toString()) : false;
    const commentsCount = await Comment.countDocuments({ postId: post._id });

    return {
      ...post,
      type: hasProduct ? 'PRODUCT' : 'POST',
      authorId: author?._id,
      displayName: isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
      displayAvatar: isBusiness ? author?.businessLogo : author?.profilePicture,
      username: isBusiness ? null : author?.username,
      likesCount: post.likes?.length || 0,
      commentsCount,
      isBookmarked: true, // It's in the bookmark list, so this is always true
      isLiked,
      isVerified: author?.isVerified || false,
      rating: ratingData.average,
      reviewCount: ratingData.count,
      isFeatured: ratingData.average >= 4.5 && ratingData.count > 10
    };
  }));

  res.status(200).json(formattedPosts);
});