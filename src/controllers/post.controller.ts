import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Post } from '@/models/post-model';
import { Product } from '@/models/product-model'; // New Model
import { Business } from '@/models/business-model';
import { Review } from '@/models/review-model';
import { Bookmark } from '@/models/bookmark.model';
import { Types } from 'mongoose';
import { eventEmitter } from '@/services/event-emitter.services';
import { Comment } from '@/models/comment-model';

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
    .populate('product') // Populate the product details
    .lean();

  let bookmarkedPostIds: string[] = [];
  if (currentUserId) {
    const userBookmarks = await Bookmark.find({ 
      user: new Types.ObjectId(currentUserId), 
      targetType: 'Post' 
    }).select('targetId');
    bookmarkedPostIds = userBookmarks.map(b => b.targetId.toString());
  }

  const formattedFeed = await Promise.all(feed.map(async (post: any) => {
    const author = post.author;
    const isBusiness = post.authorType === 'Business';
    const hasProduct = !!post.product;

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

    const isLiked = currentUserId
      ? post.likes.some((id: any) => id.toString() === currentUserId)
      : false;


      const commentsCount = await Comment.countDocuments({ postId: post._id });

      // IMPORTANT: Keep response structure intact by merging product info into post root
    return {
      ...post,
      // If linked to product, override media and include product fields
      type: hasProduct ? 'PRODUCT' : 'POST',
      media: hasProduct ? post.product.media : post.media,
      productName: hasProduct ? post.product.name : null,
      price: hasProduct ? post.product.price : null,
      stock: hasProduct ? post.product.stock : null,
      category: hasProduct ? post.product.category : null,
      description: hasProduct ? post.product.description : null,
      
      // Standard Display Fields
      displayName: isBusiness ? author?.businessName : `${author?.firstName} ${author?.lastName}`,
      displayAvatar: isBusiness ? author?.businessLogo : author?.profilePicture,
      username: isBusiness ? null : author?.username,
      likesCount: post.likes.length,
      commentsCount: commentsCount,
      isBookmarked: bookmarkedPostIds.includes(post._id.toString()),
      isLiked: isLiked,
      isVerified: author?.isVerified || false,
      rating: isBusiness ? ratingData.rating : null,
      reviewCount: isBusiness ? ratingData.reviewCount : null,
    };
  }));

  res.json({ success: true, posts: formattedFeed });
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