import { asyncHandler } from "@/middleware/errorHandler";
import { Comment } from "@/models/comment-model";
import { Post } from "@/models/post-model";
import { Request, Response } from 'express';
import { Model, Types } from 'mongoose';
import { Business } from "@/models/business-model";
import { User } from "@/models/user-model";
import { Product } from "@/models/product-model";
import { Wishlist } from "@/models/wishlist-model";
import { trackEvent } from "@/services/track-event.service"; // Import our new service

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

const getAuthUser = (req: Request) => {
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;

  if (!userId) {
    return null;
  }
  return { userId, role: user.role };
};

// 1. Toggle Like (Post/Product)
export const toggleLike = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetType, targetId } = req.params;
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ message: "User not authenticated" }); return; }

  const TargetModel = (targetType === 'product' ? Product : Post) as Model<any>;
  const ownerField = targetType === 'product' ? 'business' : 'author';
  const ownerModel = targetType === 'product' ? 'Business' : 'User';

  const doc = await TargetModel.findById(targetId);
  if (!doc) { res.status(404).json({ message: `${targetType} not found` }); return; }

  const postOrProduct = doc as any;
  const isLiked = postOrProduct.likes.some((id: any) => id.toString() === userId);

  if (isLiked) {
    postOrProduct.likes = postOrProduct.likes.filter((id: any) => id.toString() !== userId);
    
    // Only log activity for the actor
    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {action: 'UNLIKE', description: `You unliked a ${targetType}`}
    });
  } else {
    postOrProduct.likes.push(new Types.ObjectId(userId));

    // Notify the Owner and log Activity
    await trackEvent({
        targetId: userId, // The actor (for activity)
        targetModel: 'User',
        type: 'BOTH',
        notificationData: {
            type: 'SOCIAL',
            title: 'New Like!',
            message: `${(req as any).user.firstName} liked your ${targetType}.`,
            sender: userId,
            senderModel: 'User',
            relatedId: targetId,
            modelType: targetType === 'product' ? 'Product' : 'Post',
            // This part triggers the notification to the owner
        },
        activityData: {action: 'LIKE', description: `You liked a ${targetType}`}
    });

    // Send the actual notification to the owner separately
    await trackEvent({
        targetId: postOrProduct[ownerField].toString(),
        targetModel: ownerModel,
        type: 'NOTIFICATION',
        notificationData: {
            type: 'SOCIAL',
            title: 'New Like!',
            message: `${(req as any).user.firstName} liked your ${targetType}.`,
            sender: userId,
            senderModel: 'User',
            relatedId: targetId,
            modelType: targetType === 'product' ? 'Product' : 'Post',
        }
    });
  }

  await postOrProduct.save();
  res.json({ success: true, isLiked: !isLiked, likesCount: postOrProduct.likes.length });
});

// 2. Toggle Bookmark
export const toggleBookmark = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params;
  const { targetType } = req.body; // 'Post' or 'Business'
  const userId = getAuthUserId(req)!;

  const isPost = targetType === 'Post';
  const bookmarkField = isPost ? 'bookmarkedPosts' : 'bookmarkedBusinesses';

  const user = await User.findById(userId);
  const isAlreadyBookmarked = (user![bookmarkField] as Types.ObjectId[]).some(id => id.toString() === targetId);

  if (isAlreadyBookmarked) {
    await User.findByIdAndUpdate(userId, { $pull: { [bookmarkField]: targetId } });
    
    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {action: 'UNBOOKMARK', description: `Removed ${targetType} from bookmarks`}
    });

    res.json({ success: true, isBookmarked: false });
  } else {
    // Logic for ADDING
    await User.findByIdAndUpdate(userId, { $addToSet: { [bookmarkField]: targetId } });

    // If it's a business, notify the business owner
    if (targetType === 'Business') {
      await trackEvent({
          targetId: targetId, // The Business ID
          targetModel: 'Business',
          type: 'NOTIFICATION',
          notificationData: {
              type: 'BUSINESS',
              title: 'New Bookmark',
              message: `${user?.firstName} bookmarked your business.`,
              sender: userId,
              senderModel: 'User',
              relatedId: targetId,
              modelType: 'Business'
          }
      });
    }

    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {action: 'BOOKMARK', description: `Bookmarked a ${targetType}`}
    });

    res.json({ success: true, isBookmarked: true });
  }
});

// 3. Toggle Follow
export const toggleFollow = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params;
  const { isBusiness } = req.body;
  const userId = getAuthUserId(req)!;

  const user = await User.findById(userId);
  const followerArray = isBusiness ? "followingBusinesses" : "followingUsers";
  const isAlreadyFollowing = user![followerArray].some(id => id.toString() === targetId);

  if (isAlreadyFollowing) {
    // Unfollow logic...
    await User.findByIdAndUpdate(userId, { $pull: { [followerArray]: targetId } });
    const TargetModel = isBusiness ? Business : User;
    await (TargetModel as any).findByIdAndUpdate(targetId, { $pull: { followers: userId } });

    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {action: 'UNFOLLOW', description: `Unfollowed a ${isBusiness ? 'Business' : 'User'}`}
    });

    res.status(200).json({ message: "Unfollowed", isFollowing: false });
  } else {
    // Follow logic...
    await User.findByIdAndUpdate(userId, { $push: { [followerArray]: targetId } });
    const TargetModel = isBusiness ? Business : User;
    await (TargetModel as any).findByIdAndUpdate(targetId, { $push: { followers: userId } });

    // Notify the recipient
    await trackEvent({
        targetId: targetId,
        targetModel: isBusiness ? 'Business' : 'User',
        type: 'NOTIFICATION',
        notificationData: {
            type: 'SOCIAL',
            title: 'New Follower',
            message: `${user?.firstName} started following you.`,
            sender: userId,
            senderModel: 'User'
        }
    });

    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {action: 'FOLLOW', description: `Followed a ${isBusiness ? 'Business' : 'User'}`}
    });

    res.status(200).json({ message: "Followed", isFollowing: true });
  }
});

// 4. Toggle Wishlist
export const toggleWishlist = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { productId } = req.params;
  const userId = getAuthUserId(req)!;
  const product = await Product.findById(productId);
  if (!product) { res.status(404).json({ message: "Product not found" }); return; }

  const existingWishlist = await Wishlist.findOne({ user: userId, product: productId });

  if (existingWishlist) {
    await Wishlist.deleteOne({ _id: existingWishlist._id });
    res.json({ success: true, isWishlisted: false });
  } else {
    await Wishlist.create({ user: userId, product: productId });

    // Notify the Business Owner
    await trackEvent({
        targetId: product.business.toString(),
        targetModel: 'Business',
        type: 'NOTIFICATION',
        notificationData: {
            type: 'BUSINESS',
            title: 'Product Wishlisted',
            message: `Someone added ${product.name} to their wishlist.`,
            sender: userId,
            senderModel: 'User',
            relatedId: productId,
            modelType: 'Product'
        }
    });

    res.json({ success: true, isWishlisted: true });
  }
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
