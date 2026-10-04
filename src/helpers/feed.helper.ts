import { Types } from 'mongoose';
import { Review } from '@/models/review-model';
import { Comment } from '@/models/comment-model';

export async function getRatingForBusiness(
  businessId: Types.ObjectId | string,
): Promise<{ average: number; count: number }> {
  const rows = await Review.aggregate([
    { $match: { reviewedItem: new Types.ObjectId(businessId.toString()) } },
    { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  if (!rows.length) return { average: 0, count: 0 };
  return {
    average: Math.round(rows[0].avgRating * 10) / 10,
    count: rows[0].count,
  };
}

export async function buildFeedPost(
  post: any,
  currentUserId: string | null,
  bookmarkedPostIds: string[],
): Promise<Record<string, unknown>> {
  const author     = post.author;
  const isBusiness = post.authorType === 'Business';
  const hasProduct = !!post.product;

  const [commentsCount, ratingData] = await Promise.all([
    Comment.countDocuments({ postId: post._id }),
    isBusiness ? getRatingForBusiness(author?._id) : Promise.resolve({ average: 0, count: 0 }),
  ]);

  return {
    ...post,
    type:          hasProduct ? 'PRODUCT' : 'POST',
    authorId:      author?._id,
    displayName:   isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
    displayAvatar: isBusiness ? author?.businessLogo  : author?.profilePicture,
    // Public page link for business authors (ura.com.ng/<slug>).
    businessSlug:  isBusiness ? author?.slug : undefined,
    username:      isBusiness ? null : author?.username,
    likesCount:    post.likes?.length ?? 0,
    commentsCount,
    isBookmarked:  bookmarkedPostIds.includes(post._id.toString()),
    isLiked:       currentUserId
      ? post.likes?.some((id: any) => id.toString() === currentUserId)
      : false,
    isVerified:    author?.isVerified || false,
    rating:        ratingData.average,
    reviewCount:   ratingData.count,
    isFeatured:    ratingData.average >= 4.5 && ratingData.count > 10,
  };
}
