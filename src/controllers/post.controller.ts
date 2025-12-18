import { asyncHandler } from '@/middleware/errorHandler';
import { Post, PostType } from '@/models/post-model';
import { Request, Response, NextFunction } from 'express';
import { Business } from '@/models/business-model';
import { Review } from '@/models/review-model';
import { Types } from 'mongoose';
import { Bookmark } from '@/models/bookmark.model';

// export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response) => {
//   const feed = await Post.find()
//     .sort({ createdAt: -1 })
//     .limit(20)
//     .populate({
//       path: 'author',
//       // Based on your IBusiness and IUser schemas:
//       select: 'username firstName lastName profilePicture businessName businessLogo isVerified' 
//     });

//   const formattedFeed = await Promise.all(feed.map(async (post: any) => {
//     const author = post.author;
//     const isBusiness = post.authorType === 'Business';

//     // 1. Calculate Ratings for Business if it's a PRODUCT post
//     let ratingData = { rating: 0, reviewCount: 0 };
//     if (isBusiness) {
//       const reviews = await Review.find({ reviewedItem: author._id, reviewedItemModel: 'Business' });
//       const total = reviews.reduce((acc, rev) => acc + rev.rating, 0);
//       ratingData = {
//         rating: reviews.length > 0 ? Number((total / reviews.length).toFixed(1)) : 0,
//         reviewCount: reviews.length
//       };
//     }

//     return {
//       ...post._doc,
//       // Mapping to your schema's specific names
//       displayName: isBusiness 
//         ? author.businessName 
//         : `${author.firstName} ${author.lastName}`,

//       displayAvatar: isBusiness 
//         ? author.businessLogo  // Schema uses businessLogo, not profileImage
//         : author.profilePicture,

//       username: isBusiness ? null : author.username,

//       // Additional Data for design
//       isVerified: author.isVerified || false, // Add this to Business Schema if needed
//       rating: isBusiness ? ratingData.rating : null,
//       reviewCount: isBusiness ? ratingData.reviewCount : null,
//     };
//   }));

//   res.json({ success: true, posts: formattedFeed });
// });





// backend/controllers/feedController.ts

export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response) => {
  const currentUserId = req.user?._id; // Optional: user might not be logged in
  const feed = await Post.find()
    .sort({ createdAt: -1 })
    .limit(20)
    .populate({
      path: 'author',
      select: 'username firstName lastName profilePicture businessName businessLogo isVerified'
    });

  // Get all bookmarks by this user to check against posts efficiently
  const userBookmarks = currentUserId
    ? await Bookmark.find({ user: currentUserId, targetType: 'Post' }).select('targetId')
    : [];
  const bookmarkedPostIds = userBookmarks.map(b => b.targetId.toString());

  const formattedFeed = await Promise.all(feed.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';

    // ... your existing review calculation logic here ...
    // 1. Calculate Ratings for Business if it's a PRODUCT post
    let ratingData = { rating: 0, reviewCount: 0 };
    if (isBusiness) {
      const reviews = await Review.find({ reviewedItem: author._id, reviewedItemModel: 'Business' });
      const total = reviews.reduce((acc, rev) => acc + rev.rating, 0);
      ratingData = {
        rating: reviews.length > 0 ? Number((total / reviews.length).toFixed(1)) : 0,
        reviewCount: reviews.length
      };
    }
    // 1. Get the current user ID from the request (ensure it's a string)
    const userIdStr = currentUserId?.toString();

    // 2. Check if the user ID exists in the likes array by converting each element to a string
    const isLiked = userIdStr
      ? post.likes.some((id: any) => id.toString() === userIdStr)
      : false;
    return {
      ...post._doc,
      displayName: isBusiness ? author.businessName : `${author.firstName} ${author.lastName}`,
      displayAvatar: isBusiness ? author.businessLogo : author.profilePicture,
      username: isBusiness ? null : author.username,

      // 🚨 NEW INTERACTION DATA
      likesCount: post.likes.length,
      isBookmarked: bookmarkedPostIds.includes(post._id.toString()),
      isLiked: isLiked,
      isVerified: author.isVerified || false,
      rating: isBusiness ? ratingData.rating : null,
      reviewCount: isBusiness ? ratingData.reviewCount : null,
    };
  }));

  res.json({ success: true, posts: formattedFeed });
});






export const createPost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = (req.user as any)._id;
  const { type } = req.body;

  let authorId: Types.ObjectId = userId;
  let authorType: 'User' | 'Business' = 'User';

  if (type === PostType.PRODUCT) {
    const business = await Business.findOne({ owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Business profile required." });
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

  res.status(201).json({ success: true, data: post });
});
// import { eventEmitter } from '@/services/event-emitter.services'; // NEW IMPORT

// export const toggleBookmark = asyncHandler(async (req: Request, res: Response) => {
//     const userId = (req as unknown as { user: { id: string } }).user.id;
//     const postId = req.params.postId;

//     // ... Primary action logic here ...
//     const post = await Post.findById(postId).select('author');

//     if (post) {
//         // 🚨 Fire the event! The controller does NOT care how the logging is done.
//         eventEmitter.emit('activityLogged', {
//             actorId: userId,
//             actionType: 'bookmark',
//             targetModel: 'Post',
//             targetId: postId,
//             targetOwnerId: post.author.toString(),
//         });
//     }

//     res.json({ success: true, message: 'Bookmark toggled.' });
// });