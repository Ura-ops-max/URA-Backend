// controllers/reviewController.ts
import { Request, Response } from 'express';
import { Review } from '@/models/review-model';
import { Business } from '@/models/business-model';
import { Product } from '@/models/product-model';
import { trackEvent } from '@/services/track-event.service';
import { Types } from 'mongoose';

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
/**
 * CREATE REVIEW
 */
export const createReview = async (req: Request, res: Response) => {
  try {

    const { reviewedItem, reviewedItemModel, rating, comment } = req.body;
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    // 1. Business Logic: Check if user already reviewed this item
    const existingReview = await Review.findOne({ reviewedItem, user: userId });
    if (existingReview) {
      return res.status(400).json({ success: false, message: "You have already reviewed this item. Please update your existing review." });
    }
    const review = await Review.create({
      reviewedItem,
      reviewedItemModel,
      user: userId,
      rating,
      comment,
    });


    // 🚨 TRACK EVENT LOGIC
    // 1. Determine who needs to be notified (Business Owner or Product Owner)
    let recipientId: string | null = null;
    let itemName = "your item";

    if (reviewedItemModel === 'Business') {
      const biz = await Business.findById(reviewedItem);
      recipientId = biz?.owner?.toString() || null;
      itemName = biz?.businessName || "your business";
    } else if (reviewedItemModel === 'Product') {
      const prod = await Product.findById(reviewedItem).populate('business');
      // Assuming product has a 'business' field which has an 'owner'
      recipientId = (prod as any)?.business?.owner?.toString() || null;
      itemName = prod?.name || "your product";
    }

    // 2. Log Activity for the Reviewer
    await trackEvent({
      targetId: userId,
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
        action: 'REVIEW_CREATE',
        description: `You gave a ${rating}-star review to ${itemName}`,
        metadata: { contentPreview: comment?.substring(0, 50) }
      }
    });

    // 3. Notify the Owner
    if (recipientId) {
      await trackEvent({
        targetId: recipientId,
        targetModel: 'User',
        type: 'NOTIFICATION',
        notificationData: {
          type: 'BUSINESS',
          title: 'New Review Received',
          message: `left a ${rating}-star review on ${itemName}`,
          sender: userId,
          senderModel: 'User',
          relatedId: (review._id as any).toString(),
          modelType: reviewedItemModel as any
        }
      });
    }

    res.status(201).json({ success: true, data: review });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "You have already reviewed this item." });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * GET REVIEWS FOR AN ITEM (Business or Product)
 */
export const getItemReviews = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const reviews = await Review.find({ reviewedItem: itemId })
      .populate('user', 'firstName lastName profilePicture username')
      .sort({ createdAt: -1 });

    res.status(200).json({
      status: 'success',
      results: reviews.length,
      data: reviews, // Frontend maps this to formatted data
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};





/**
 * @desc    Toggle Like on a review (Atomic)
 */
export const toggleLikeReview = (async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  const review = await Review.findById(id);
  if (!review) return res.status(400).json({ success: false, message: 'Review not found' });


  const hasLiked = review.likes.includes(userId);
  const hasDisliked = review.dislikes.includes(userId);

  if (hasLiked) {
    // If already liked, unlike it
    review.likes = review.likes.filter((uid) => uid.toString() !== userId);
  } else {
    // Like it and ensure it's removed from dislikes
    review.likes.push(userId);
    if (hasDisliked) {
      review.dislikes = review.dislikes.filter((uid) => uid.toString() !== userId);
    }
  }

  await review.save();
  res.status(200).json({ status: 'success', data: review });
});


/**
 * @desc    Toggle Dislike on a review
 */
export const toggleDislikeReview = (async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  const review = await Review.findById(id);
  if (!review) return res.status(400).json({ success: false, message: 'Review not found' });

  const hasLiked = review.likes.includes(userId);
  const hasDisliked = review.dislikes.includes(userId);

  if (hasDisliked) {
    review.dislikes = review.dislikes.filter((uid) => uid.toString() !== userId);
  } else {
    review.dislikes.push(userId);
    if (hasLiked) {
      review.likes = review.likes.filter((uid) => uid.toString() !== userId);
    }
  }

  await review.save();
  res.status(200).json({ status: 'success', data: review });
});

/**
 * @desc    Update Review (Only Owner)
 */
export const updateReview = (async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  const review = await Review.findOneAndUpdate(
    { _id: req.params.id, user: userId },
    { rating: req.body.rating, comment: req.body.comment },
    { new: true, runValidators: true }
  );

  if (!review) return res.status(400).json({ success: false, message: 'Review not found' });

  res.status(200).json({ status: 'success', data: review });
});

/**
 * @desc    Delete Review
 */
export const deleteReview = (async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id || user?._id || user?.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  const review = await Review.findOneAndDelete({ _id: req.params.id, user: userId });

  if (!review) return res.status(400).json({ success: false, message: 'Review not found' });


  res.status(204).json({ status: 'success', data: null });
});