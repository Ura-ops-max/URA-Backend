// backend/controllers/feedController.ts
import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Post, PostType } from '@/models/post-model';
import { Business } from '@/models/business-model';
import { Review } from '@/models/review-model';
import { Bookmark } from '@/models/bookmark.model';
import { Types } from 'mongoose';
import { eventEmitter } from '@/services/event-emitter.services';

/**
 * Helper to safely extract user ID
 */
const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

// GET UNIFIED FEED
export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);

  const feed = await Post.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .populate({
      path: 'author',
      select: 'username firstName lastName profilePicture businessName businessLogo isVerified'
    })
    .lean(); // Use lean() for faster performance since we are mapping anyway

  // 1. Efficiently get bookmarks if user is logged in
  let bookmarkedPostIds: string[] = [];
  if (currentUserId) {
    const userBookmarks = await Bookmark.find({ 
      user: new Types.ObjectId(currentUserId), 
      targetType: 'Post' 
    }).select('targetId');
    bookmarkedPostIds = userBookmarks.map(b => b.targetId.toString());
  }

  // 2. Format the feed items
  const formattedFeed = await Promise.all(feed.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';

    // Calculate Ratings for Business
    let ratingData = { rating: 0, reviewCount: 0 };
    if (isBusiness && author) {
      const reviews = await Review.find({ 
        reviewedItem: author._id, 
        reviewedItemModel: 'Business' 
      });
      const total = reviews.reduce((acc, rev) => acc + rev.rating, 0);
      ratingData = {
        rating: reviews.length > 0 ? Number((total / reviews.length).toFixed(1)) : 0,
        reviewCount: reviews.length
      };
    }

    // Check interaction states
    const isLiked = currentUserId
      ? post.likes.some((id: any) => id.toString() === currentUserId)
      : false;

    return {
      ...post,
      displayName: isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
      displayAvatar: isBusiness ? author?.businessLogo : author?.profilePicture,
      username: isBusiness ? null : author?.username,
      likesCount: post.likes.length,
      isBookmarked: bookmarkedPostIds.includes(post._id.toString()),
      isLiked: isLiked,
      isVerified: author?.isVerified || false,
      rating: isBusiness ? ratingData.rating : null,
      reviewCount: isBusiness ? ratingData.reviewCount : null,
    };
  }));

  res.json({ success: true, posts: formattedFeed });
});

// CREATE POST
export const createPost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const { type, content } = req.body;

  let authorId: Types.ObjectId = new Types.ObjectId(userId);
  let authorType: 'User' | 'Business' = 'User';

  // If it's a product post, the author is the Business, not the User
  if (type === PostType.PRODUCT) {
    const business = await Business.findOne({ owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Business profile required to post products." });
      return;
    }
    authorId = business._id as Types.ObjectId;
    authorType = 'Business';
  }

  const post = await Post.create({
    ...req.body,
    author: authorId,
    authorType: authorType
  });

  // 🚨 EVENT LOG: Log the 'signup' or 'post' activity
  // Since you wanted to store activities, we log the creation of a post
  eventEmitter.emit('activityLogged', {
    actorId: userId, // The user who did it
    actionType: 'post', // Or use a new type like 'post' if you add it to your schema
    targetModel: 'Post',
    targetId: (post._id as Types.ObjectId).toString(),
    targetOwnerId: userId, // They own their own post
    contentPreview: content?.substring(0, 50)
  });

  res.status(201).json({ success: true, data: post });
});