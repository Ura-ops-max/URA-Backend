import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Post } from '@/models/post-model';
import { Product } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { Review } from '@/models/review-model';
import { Types } from 'mongoose';
import { trackEvent } from '@/services/track-event.service'; // Updated import
import { Comment } from '@/models/comment-model';
import { User } from '@/models/user-model';
import { Wishlist } from '@/models/wishlist-model';
import { PRODUCT_CATEGORIES } from '@/constants/categories.constant';

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

// GET UNIFIED FEED
export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const targetUserId = req.query.userId as string;

  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;

  let posts;
  let bookmarkedPostIds: string[] = [];

  if (currentUserId) {
    const currentUser = await User.findById(currentUserId).select('bookmarkedPosts followingUsers followingBusinesses');
    if (currentUser) {
      bookmarkedPostIds = currentUser.bookmarkedPosts.map(id => id.toString());
    }
  }

  if (targetUserId) {
    posts = await Post.find({
      $or: [
        { author: new Types.ObjectId(targetUserId) },
        { likes: new Types.ObjectId(targetUserId) },
        { _id: { $in: (await User.findById(targetUserId).select('bookmarkedPosts'))?.bookmarkedPosts || [] } }
      ]
    });
  } else if (currentUserId) {
    const user = await User.findById(currentUserId);
    const following = [...(user?.followingUsers || []), ...(user?.followingBusinesses || [])];

    posts = await Post.find({
      $or: [
        { author: { $in: [...following, new Types.ObjectId(currentUserId)] } },
        { likes: new Types.ObjectId(currentUserId) },
        { _id: { $in: user?.bookmarkedPosts || [] } },
        {}
      ]
    });
  } else {
    posts = await Post.find({});
  }

  const feed = await Post.find({ _id: { $in: posts.map(p => p._id) } })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: 'author',
      select: '_id username firstName lastName profilePicture businessName businessLogo isVerified'
    })
    .populate('product')
    .lean();

  const formattedFeed = await Promise.all(feed.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';
    const hasProduct = !!post.product;

    let ratingData = { average: 0, count: 0 };
    if (isBusiness) {
      const businessId = author?._id;
      const reviews = await Review.aggregate([
        { $match: { reviewedItem: new Types.ObjectId(businessId) } },
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
    const isLiked = currentUserId ? post.likes.some((id: any) => id.toString() === currentUserId) : false;
    const commentsCount = await Comment.countDocuments({ postId: post._id });

    return {
      ...post,
      type: hasProduct ? 'PRODUCT' : 'POST',
      authorId: author?._id,
      displayName: isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
      displayAvatar: isBusiness ? author?.businessLogo : author?.profilePicture,
      username: isBusiness ? null : author?.username,
      likesCount: post.likes.length,
      commentsCount,
      isBookmarked: bookmarkedPostIds.includes(post._id.toString()),
      isLiked,
      isVerified: author?.isVerified || false,
      rating: ratingData.average,
      reviewCount: ratingData.count,
      isFeatured: ratingData.average >= 4.5 && ratingData.count > 10
    };
  }));

  res.json({ success: true, posts: formattedFeed });
});

// GET /api/posts/social
export const getSocialPosts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const { authorId, restrict, page = "1" } = req.query;

  const p = parseInt(page as string) || 1;
  const limit = 15;
  const skip = (p - 1) * limit;

  let query: any = {};

  if (restrict === 'true' && authorId) {
    query.author = new Types.ObjectId(authorId as string);
  } else if (authorId) {
    const user = await User.findById(authorId);
    const following = [...(user?.followingUsers || []), ...(user?.followingBusinesses || [])];
    query.$or = [
      { author: { $in: [...following, new Types.ObjectId(authorId as string)] } },
      { likes: new Types.ObjectId(authorId as string) }
    ];
  }

  let bookmarkedPostIds: string[] = [];
  if (currentUserId) {
    const user = await User.findById(currentUserId).select('bookmarkedPosts');
    bookmarkedPostIds = user?.bookmarkedPosts.map(id => id.toString()) || [];
  }

  const posts = await Post.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: 'author',
      select: '_id username firstName lastName profilePicture businessName businessLogo isVerified'
    })
    .populate('product')
    .lean();

  const formattedPosts = await Promise.all(posts.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';
    const productData = post.product as any;

    let ratingData = { average: 0, count: 0 };
    if (isBusiness) {
      const businessId = author?._id;
      const reviews = await Review.aggregate([
        { $match: { reviewedItem: new Types.ObjectId(businessId) } },
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


    const displayMedia = productData ? productData.media : post.media;
    const isLiked = currentUserId ? post.likes.some((id: any) => id.toString() === currentUserId) : false;
    const commentsCount = await Comment.countDocuments({ postId: post._id });

    return {
      ...post,
      media: displayMedia,
      type: productData ? 'PRODUCT' : 'POST',
      authorId: author?._id,
      displayName: isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
      displayAvatar: isBusiness ? author?.businessLogo : author?.profilePicture,
      username: isBusiness ? null : author?.username,
      likesCount: post.likes.length,
      commentsCount,
      isBookmarked: bookmarkedPostIds.includes(post._id.toString()),
      isLiked,
      isVerified: author?.isVerified || false,
      productDetails: productData || null,
      rating: ratingData.average,
      reviewCount: ratingData.count,
      isFeatured: ratingData.average >= 4.5 && ratingData.count > 10
    };
  }));

  res.json({ success: true, posts: formattedPosts });
});

// GET /api/posts/products
export const getProductCatalog = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const { businessId, restrict, page = "1" } = req.query;

  const p = parseInt(page as string) || 1;
  const limit = 15;
  const skip = (p - 1) * limit;

  let query: any = {};
  if (restrict === 'true' && businessId) {
    query.business = new Types.ObjectId(businessId as string);
  }

  let wishlistProductIds = new Set();
  if (currentUserId) {
    const userWishlist = await Wishlist.find({ user: currentUserId }).select('product');
    wishlistProductIds = new Set(userWishlist.map(w => w.product.toString()));
  }

  const products = await Product.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: 'business',
      select: '_id businessName businessLogo isVerified'
    })
    .lean();

  const formattedProducts = products.map((product: any) => {
    const isLiked = currentUserId
      ? product.likes?.some((id: any) => id.toString() === currentUserId)
      : false;

    return {
      ...product,
      type: 'PRODUCT',
      authorId: product.business?._id,
      displayName: product.business?.businessName,
      displayAvatar: product.business?.businessLogo,
      isVerified: product.business?.isVerified || false,
      likesCount: product.likes?.length || 0,
      isLiked,
      isWishlisted: wishlistProductIds.has(product._id.toString()),
    };
  });

  res.json({ success: true, posts: formattedProducts });
});

// CREATE POST / PRODUCT
export const createPost = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const { type, caption, tags, publishToFeed, productId } = req.body;
  let authorId: Types.ObjectId = new Types.ObjectId(userId);
  let authorType: 'User' | 'Business' = 'User';
  let finalProductId = productId;

  if (type === 'PRODUCT' || (type === 'POST' && productId)) {
    const business = await Business.findOne({ owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Business profile required." });
      return;
    }
    authorId = business._id as Types.ObjectId;
    authorType = 'Business';

    if (type === 'PRODUCT') {
      const newProduct = await Product.create({
        business: authorId,
        name: req.body.productName,
        category: req.body.category || 'General',
        description: req.body.description,
        price: req.body.price,
        stock: req.body.stock,
        size: req.body.size,
        media: req.body.media
      });
      finalProductId = newProduct._id;

      // 🚨 Log Product Inventory Addition
      await trackEvent({
          targetId: userId,
          targetModel: 'User',
          type: 'ACTIVITY',
          activityData: {
              action: 'PRODUCT_CREATE',
              description: `You added ${req.body.productName} to your inventory`,
          }
      });
    }
  }

  let post = null;
  if (type === 'POST' || (type === 'PRODUCT' && publishToFeed)) {
    post = await Post.create({
      author: authorId,
      authorType: authorType,
      caption: caption,
      tags: tags,
      product: finalProductId,
      media: finalProductId ? [] : req.body.media
    });

    // 🚨 TRACK EVENT: Post Published
    await trackEvent({
        targetId: userId,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'POST_PUBLISH',
            description: type === 'PRODUCT' ? `You published a product post` : `You shared a new post`,
            metadata: {contentPreview: caption?.substring(0, 50)}
        }
    });
  }

  res.status(201).json({
    success: true,
    data: post || { productId: finalProductId },
    message: post ? "Published successfully" : "Product saved to inventory"
  });
});

// EDIT POST OR PRODUCT
export const updateItem = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;
  const { type } = req.query;

  if (type === 'product') {
    const updatedProduct = await Product.findOneAndUpdate(
      { _id: id },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    await trackEvent({
        targetId: userId!,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'PRODUCT_UPDATE',
            description: `You updated product: ${updatedProduct.name}`,
        }
    });

    res.json({ success: true, data: updatedProduct });
  } else {
    const post = await Post.findById(id);
    if (!post) {
      res.status(404).json({ success: false, message: "Post not found" });
      return;
    }

    const updates: any = {
      caption: req.body.caption,
      tags: req.body.tags
    };

    if (!post.product && req.body.media) {
      updates.media = req.body.media;
    }

    const updatedPost = await Post.findByIdAndUpdate(id, { $set: updates }, { new: true });

    await trackEvent({
        targetId: userId!,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'POST_UPDATE',
            description: `You updated a post`,
        }
    });

    res.json({ success: true, data: updatedPost });
  }
});

// DELETE POST OR PRODUCT
export const deleteItem = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;
  const { type } = req.query;

  if (type === 'product') {
    const product = await Product.findById(id);
    if (!product) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    const business = await Business.findOne({ _id: product.business, owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Unauthorized to delete this product" });
      return;
    }

    await Product.findByIdAndDelete(id);
    await Post.deleteMany({ product: id });

    await trackEvent({
        targetId: userId!,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'PRODUCT_DELETE',
            description: `You deleted product: ${product.name} and its posts`,
        }
    });

    res.json({ success: true, message: "Product and associated posts deleted" });
  } else {
    const post = await Post.findById(id);
    if (!post) {
      res.status(404).json({ success: false, message: "Post not found" });
      return;
    }

    await Post.findByIdAndDelete(id);

    await trackEvent({
        targetId: userId!,
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'POST_DELETE',
            description: `You deleted a post`,
        }
    });

    res.json({ success: true, message: "Post deleted successfully" });
  }
});

export const getMyProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const business = await Business.findOne({ owner: userId });

  if (!business) {
    res.json({ success: true, products: [] });
    return;
  }

  const products = await Product.find({ business: business._id }).sort({ createdAt: -1 });
  res.json({ success: true, products });
});

export const getProductCategories = (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: PRODUCT_CATEGORIES
  });
};

export const getProductDetails = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const currentUserId = getAuthUserId(req);

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid Product ID" });
      return;
    }

    const product = await Product.findById(id)
      .populate('business', '_id businessName businessLogo isVerified')
      .lean();

    if (!product) {
      res.status(404).json({ message: "Product not found" });
      return;
    }

    const relatedProducts = await Product.find({
      category: product.category,
      _id: { $ne: product._id }
    })
      .limit(4)
      .select('name price media category stock')
      .lean();

    const isLiked = currentUserId
      ? product.likes?.some((id: any) => id.toString() === currentUserId)
      : false;

    let isWishlisted = false;
    if (currentUserId) {
      const wishlistEntry = await Wishlist.findOne({
        user: new Types.ObjectId(currentUserId),
        product: product._id
      });
      isWishlisted = !!wishlistEntry;
    }

    const formattedProduct = {
      ...product,
      isLiked,
      isWishlisted,
      likesCount: product.likes?.length || 0,
      authorId: (product.business as any)?._id,
      displayName: (product.business as any)?.businessName,
      displayAvatar: (product.business as any)?.businessLogo,
    };

    res.status(200).json({
      success: true,
      product: formattedProduct,
      relatedProducts
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({ success: false, message });
  }
});