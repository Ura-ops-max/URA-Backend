import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Post } from '@/models/post-model';
import { Product } from '@/models/product-model'; // New Model
import { Business } from '@/models/business-model';
import { Review } from '@/models/review-model';
import { Types } from 'mongoose';
import { eventEmitter } from '@/services/event-emitter.services';
import { Comment } from '@/models/comment-model';
import { User } from '@/models/user-model';
import { Wishlist } from '@/models/wishlist-model';

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

// GET UNIFIED FEED
export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const targetUserId = req.query.userId as string; // Optional ID for viewing a specific profile


  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;

  // ... (Your filter logic here)



  let posts;
  let bookmarkedPostIds: string[] = [];

  // 1. Get current user's bookmarks (for the "isBookmarked" flag)
  if (currentUserId) {
    const currentUser = await User.findById(currentUserId).select('bookmarkedPosts followingUsers followingBusinesses');
    if (currentUser) {
      bookmarkedPostIds = currentUser.bookmarkedPosts.map(id => id.toString());
    }
  }

  // 2. LOGIC: Determine which posts to show
  if (targetUserId) {
    /** * PROFILE VIEW MODE: Only posts related to the target user
     * (Posts they authored, liked, or bookmarked)
     */
    posts = await Post.find({
      $or: [
        { author: new Types.ObjectId(targetUserId) },
        { likes: new Types.ObjectId(targetUserId) },
        { _id: { $in: (await User.findById(targetUserId).select('bookmarkedPosts'))?.bookmarkedPosts || [] } }
      ]
    });
  } else if (currentUserId) {
    /** * MY FEED MODE: Personalized + Global
     * (Followed users/businesses, own posts, likes, bookmarks + global random)
     */
    const user = await User.findById(currentUserId);
    const following = [...(user?.followingUsers || []), ...(user?.followingBusinesses || [])];

    posts = await Post.find({
      $or: [
        { author: { $in: [...following, new Types.ObjectId(currentUserId)] } }, // Following + Self
        { likes: new Types.ObjectId(currentUserId) }, // Liked
        { _id: { $in: user?.bookmarkedPosts || [] } }, // Bookmarked
        {} // This empty object allows "Global" posts to be included in the OR
      ]
    });
  } else {
    // GUEST MODE: Just global feed
    posts = await Post.find({});
  }

  // 3. Populate and Format
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

  // Initial Filter
  let query: any = {};

  // Restriction Logic
  if (restrict === 'true' && authorId) {
    query.author = new Types.ObjectId(authorId as string);
  } else if (authorId) {
    // Global/Related logic: Following + Self + Likes + Bookmarks
    const user = await User.findById(authorId);
    const following = [...(user?.followingUsers || []), ...(user?.followingBusinesses || [])];
    query.$or = [
      { author: { $in: [...following, new Types.ObjectId(authorId as string)] } },
      { likes: new Types.ObjectId(authorId as string) }
    ];
  }

  // 1. Get current user's bookmarks for the UI flag
  let bookmarkedPostIds: string[] = [];
  if (currentUserId) {
    const user = await User.findById(currentUserId).select('bookmarkedPosts');
    bookmarkedPostIds = user?.bookmarkedPosts.map(id => id.toString()) || [];
  }

  // 2. Fetch with population
  const posts = await Post.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: 'author',
      select: '_id username firstName lastName profilePicture businessName businessLogo isVerified'
    })
    .populate('product') // Populate the IProduct link
    .lean();

  const formattedPosts = await Promise.all(posts.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';
    const productData = post.product as any;

    // UI logic: If it has a product, we prioritize product media
    const displayMedia = productData ? productData.media : post.media;

    const isLiked = currentUserId ? post.likes.some((id: any) => id.toString() === currentUserId) : false;
    const commentsCount = await Comment.countDocuments({ postId: post._id });

    return {
      ...post,
      media: displayMedia, // Flattened media for the frontend
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
      productDetails: productData || null
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

  // 1. Get User's Wishlist (IDs only) for quick comparison
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
      // Check if product ID exists in the user's wishlist Set
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

  // 1. If it involves a Business/Product, verify the business profile
  if (type === 'PRODUCT' || (type === 'POST' && productId)) {
    const business = await Business.findOne({ owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Business profile required." });
      return;
    }
    authorId = business._id as Types.ObjectId;
    authorType = 'Business';

    // 2. Handle Product Creation (if 'PRODUCT' type)
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
    }
  }

  // 3. Handle Post Creation
  // We create a post if it's a standard 'POST' OR if it's a 'PRODUCT' with 'publishToFeed' enabled
  let post = null;
  if (type === 'POST' || (type === 'PRODUCT' && publishToFeed)) {
    post = await Post.create({
      author: authorId,
      authorType: authorType,
      caption: caption,
      tags: tags,
      product: finalProductId, // Link to the new or existing product
      media: finalProductId ? [] : req.body.media // No media if linked to product
    });

    eventEmitter.emit('activityLogged', {
      actorId: userId,
      actionType: 'post',
      targetModel: 'Post',
      targetId: (post._id as Types.ObjectId).toString(),
      targetOwnerId: userId,
      contentPreview: caption?.substring(0, 50)
    });
  }

  // 4. Return response (Keep structure consistent)
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
  const { type } = req.query; // 'post' or 'product'

  if (type === 'product') {
    // 1. Update Product Details
    const updatedProduct = await Product.findOneAndUpdate(
      { _id: id },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    res.json({ success: true, data: updatedProduct });
  } else {
    // 2. Update Post Details (Only caption and tags)
    // We don't allow changing 'product' link or 'media' if it's a product-post
    const post = await Post.findById(id);
    if (!post) {
      res.status(404).json({ success: false, message: "Post not found" });
      return;
    }

    const updates: any = {
      caption: req.body.caption,
      tags: req.body.tags
    };

    // Only allow media update if it's NOT a product-linked post
    if (!post.product && req.body.media) {
      updates.media = req.body.media;
    }

    const updatedPost = await Post.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true }
    );

    res.json({ success: true, data: updatedPost });
  }
});


// DELETE POST OR PRODUCT
export const deleteItem = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;
  const { type } = req.query; // 'post' or 'product'

  if (type === 'product') {
    const product = await Product.findById(id);
    if (!product) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    // Verify ownership via Business
    const business = await Business.findOne({ _id: product.business, owner: userId });
    if (!business) {
      res.status(403).json({ success: false, message: "Unauthorized to delete this product" });
      return;
    }

    // Delete the product
    await Product.findByIdAndDelete(id);

    // CASCADE: Delete all posts that were linked to this product
    await Post.deleteMany({ product: id });

    res.json({ success: true, message: "Product and associated posts deleted" });
  } else {
    // Standard Post Deletion
    const post = await Post.findById(id);
    if (!post) {
      res.status(404).json({ success: false, message: "Post not found" });
      return;
    }

    // Check if the user owns the post (either as User or Business Owner)
    // For simplicity, we check if the authenticated userId matches the author or business owner
    await Post.findByIdAndDelete(id);
    res.json({ success: true, message: "Post deleted successfully" });
  }
});

export const getMyProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const business = await Business.findOne({ owner: userId });

  if (!business) {
    res.json({ success: true, products: [] });
    return
  }

  const products = await Product.find({ business: business._id }).sort({ createdAt: -1 });
  res.json({ success: true, products });
});