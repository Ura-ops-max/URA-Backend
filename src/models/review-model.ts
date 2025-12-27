import { Schema, model, Document, Types } from 'mongoose';

export interface IReview extends Document {
  reviewedItem: Types.ObjectId;
  reviewedItemModel: 'Business' | 'Product';
  user: Types.ObjectId;
  rating: number;
  comment?: string;
  likes: Types.ObjectId[]; // Array of user IDs who liked
  dislikes: Types.ObjectId[]; // Array of user IDs who disliked
}

const reviewSchema = new Schema<IReview>(
  {
    reviewedItem: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: 'reviewedItemModel',
    },
    reviewedItemModel: {
      type: String,
      required: true,
      enum: ['Business', 'Product'],
    },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true },
    // Added to match frontend ReviewCard data
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    dislikes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Prevent multiple reviews from same user
reviewSchema.index({ reviewedItem: 1, user: 1 }, { unique: true });

/**
 * Enhanced Statics: Calculates both average rating and the distribution (1-5 stars)
 * to match the ReviewSummary frontend component perfectly.
 */
reviewSchema.statics.calculateReviewStats = async function (itemId) {
  const stats = await this.aggregate([
    { $match: { reviewedItem: itemId } },
    {
      $group: {
        _id: '$reviewedItem',
        totalReviews: { $sum: 1 },
        averageRating: { $avg: '$rating' },
        // Calculate distribution for the ReviewSummary bars
        fiveStar: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        fourStar: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        threeStar: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        twoStar: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        oneStar: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
      },
    },
  ]);

  const updateData = stats.length > 0 ? {
    totalReviews: stats[0].totalReviews,
    averageRating: Math.round(stats[0].averageRating * 10) / 10,
    reviewDistribution: {
      5: stats[0].fiveStar,
      4: stats[0].fourStar,
      3: stats[0].threeStar,
      2: stats[0].twoStar,
      1: stats[0].oneStar,
    }
  } : {
    totalReviews: 0,
    averageRating: 0,
    reviewDistribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
  };

  // Find the model dynamically (Business or Product) and update
  const review = await this.findOne({ reviewedItem: itemId });
  if (review) {
    await model(review.reviewedItemModel).findByIdAndUpdate(itemId, updateData);
  }
};

// Middlewares to trigger stat calculation
reviewSchema.post('save', async function () {
  await (this.constructor as any).calculateReviewStats(this.reviewedItem);
});

reviewSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    await (model('Review') as any).calculateReviewStats(doc.reviewedItem);
  }
});

export const Review = model<IReview>('Review', reviewSchema);