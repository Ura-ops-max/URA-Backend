import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Post } from '@/models/post-model';
import { Product } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import { Types } from 'mongoose';
import { trackEvent } from '@/services/track-event.service';
import { getAuthUserId } from '@/utils/request.utils';
import { buildFeedPost } from '@/helpers/feed.helper';
import { tryCreateEscrow } from '@/controllers/product.controller';

// ─── Feed helpers ─────────────────────────────────────────────────────────────

async function getBookmarkedIds(userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const user = await User.findById(userId).select('bookmarkedPosts');
  return user?.bookmarkedPosts.map(id => id.toString()) ?? [];
}

async function populateFeed(query: any, skip: number, limit: number) {
  return Post.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({ path: 'author', select: '_id username firstName lastName profilePicture businessName businessLogo isVerified' })
    .populate('product')
    .lean();
}

// ─── Unified Feed ────────────────────────────────────────────────────────────

export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const targetUserId  = req.query.userId as string | undefined;
  const page          = parseInt(req.query.page as string) || 1;
  const limit         = 20;
  const skip          = (page - 1) * limit;

  let query: any = {};

  if (targetUserId) {
    // Profile feed: a specific user's own posts + the posts they've bookmarked.
    const targetUser = await User.findById(targetUserId).select('bookmarkedPosts');
    const ids = [new Types.ObjectId(targetUserId), ...((targetUser?.bookmarkedPosts ?? []) as Types.ObjectId[])];
    query = { author: { $in: ids } };
  }
  // Home feed: global/discovery — show everyone's posts (most recent first), not
  // just accounts you follow. A follow-only feed meant new accounts saw nothing
  // and their posts were invisible to everyone else. query stays {} = all posts.

  const [posts, bookmarkedPostIds] = await Promise.all([
    populateFeed(query, skip, limit),
    getBookmarkedIds(currentUserId),
  ]);

  const formattedFeed = await Promise.all(posts.map(p => buildFeedPost(p, currentUserId, bookmarkedPostIds)));
  res.json({ success: true, posts: formattedFeed });
});

// ─── Social Feed ─────────────────────────────────────────────────────────────

export const getSocialPosts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const { authorId, restrict, page = '1' } = req.query;
  const p = parseInt(page as string) || 1;
  const limit = 15;
  const skip  = (p - 1) * limit;

  let query: any = {};
  if (restrict === 'true' && authorId) {
    query.author = new Types.ObjectId(authorId as string);
  } else if (authorId) {
    const user = await User.findById(authorId);
    const follows = [...(user?.followingUsers || []), ...(user?.followingBusinesses || [])];
    query.$or = [
      { author: { $in: [...follows, new Types.ObjectId(authorId as string)] } },
      { likes: new Types.ObjectId(authorId as string) },
    ];
  }

  const [posts, bookmarkedPostIds] = await Promise.all([
    populateFeed(query, skip, limit),
    getBookmarkedIds(currentUserId),
  ]);

  const formatted = await Promise.all(
    posts.map(async post => {
      const base    = await buildFeedPost(post, currentUserId, bookmarkedPostIds);
      const product = (post as any).product;
      return { ...base, media: product ? product.media : post.media, productDetails: product || null };
    }),
  );

  res.json({ success: true, posts: formatted });
});

// ─── Single Post (shareable permalink) ───────────────────────────────────────

export const getPostById = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const id = String(req.params.id ?? '');

  if (!Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, message: 'Invalid post id' });
    return;
  }

  const post = await Post.findById(id)
    .populate({ path: 'author', select: '_id username firstName lastName profilePicture businessName businessLogo isVerified' })
    .populate('product')
    .lean();

  if (!post) {
    res.status(404).json({ success: false, message: 'Post not found' });
    return;
  }

  const bookmarkedPostIds = await getBookmarkedIds(currentUserId);
  const base    = await buildFeedPost(post, currentUserId, bookmarkedPostIds);
  const product = (post as any).product;

  res.json({
    success: true,
    post: { ...base, media: product ? product.media : (post as any).media, productDetails: product || null },
  });
});

// ─── Create (Post or Product-with-Feed-Post) ──────────────────────────────────

export const createPost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

  const { type, caption, tags, publishToFeed, productId } = req.body;

  let authorId: Types.ObjectId        = new Types.ObjectId(userId);
  let authorType: 'User' | 'Business' = 'User';
  let finalProductId                  = productId;

  if (type === 'PRODUCT' || (type === 'POST' && productId)) {
    const business = await Business.findOne({ owner: userId });
    if (!business) { res.status(403).json({ success: false, message: 'Business profile required.' }); return; }
    authorId   = business._id as Types.ObjectId;
    authorType = 'Business';

    if (type === 'PRODUCT') {
      const { productName, category, description, price, stock, size, media,
              whoPays, maxDelivery, deliveryTimeline } = req.body;

      const newProduct = await Product.create({
        business: authorId,
        name:        productName,
        category:    category || 'General',
        description,
        price,
        stock,
        size,
        media:       media ?? [],
      });
      finalProductId = newProduct._id;

      const user = await User.findById(userId).select('paylukCustomerId');
      if (user?.paylukCustomerId) {
        tryCreateEscrow({
          productId:        newProduct._id.toString(),
          productName,
          description,
          price,
          stock,
          imageUrl:         media?.[0] ?? null,
          whoPays:          whoPays || 'buyer',
          maxDelivery:      maxDelivery ?? 3,
          deliveryTimeline: deliveryTimeline || 'days',
          paylukCustomerId: user.paylukCustomerId,
        }).catch(() => {/* logged inside */});
      } else {
        console.warn(`⚠️ [Payluk] No paylukCustomerId for business ${business._id} — escrow skipped.`);
      }

      trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: { action: 'PRODUCT_CREATE', description: `You added ${productName} to your inventory` },
      }).catch(() => {});
    }
  }

  let post = null;
  if (type === 'POST' || (type === 'PRODUCT' && publishToFeed)) {
    post = await Post.create({
      author:     authorId,
      authorType,
      caption,
      tags,
      product:    finalProductId ?? undefined,
      media:      finalProductId ? [] : req.body.media,
    });

    trackEvent({
      targetId: userId,
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
        action:      'POST_PUBLISH',
        description: type === 'PRODUCT' ? 'You published a product post' : 'You shared a new post',
        metadata:    { contentPreview: caption?.substring(0, 50) },
      },
    }).catch(() => {});
  }

  res.status(201).json({
    success: true,
    data:    post || { productId: finalProductId },
    message: post ? 'Published successfully' : 'Product saved to inventory',
  });
});

// ─── Update Post ─────────────────────────────────────────────────────────────

export const updatePost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const post = await Post.findById(id);
  if (!post) { res.status(404).json({ success: false, message: 'Post not found' }); return; }

  const updates: any = { caption: req.body.caption, tags: req.body.tags };
  if (!post.product && req.body.media) updates.media = req.body.media;

  const updated = await Post.findByIdAndUpdate(id, { $set: updates }, { new: true });

  trackEvent({
    targetId: userId!,
    targetModel: 'User',
    type: 'ACTIVITY',
    activityData: { action: 'POST_UPDATE', description: 'You updated a post' },
  }).catch(() => {});

  res.json({ success: true, data: updated });
});

// ─── Delete Post ─────────────────────────────────────────────────────────────

export const deletePost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const post = await Post.findByIdAndDelete(id);
  if (!post) { res.status(404).json({ success: false, message: 'Post not found' }); return; }

  trackEvent({
    targetId: userId!,
    targetModel: 'User',
    type: 'ACTIVITY',
    activityData: { action: 'POST_DELETE', description: 'You deleted a post' },
  }).catch(() => {});

  res.json({ success: true, message: 'Post deleted successfully' });
});
