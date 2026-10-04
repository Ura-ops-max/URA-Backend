import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { Product } from '@/models/product-model';
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import { Wishlist } from '@/models/wishlist-model';
import { Types } from 'mongoose';
import { trackEvent } from '@/services/track-event.service';
import { createPaymentLink, PaylukError } from '@/services/payluk.service';
import { PRODUCT_CATEGORIES } from '@/constants/categories.constant';
import { getAuthUserId } from '@/utils/request.utils';
import { embedImageUrl } from '@/services/ai-embed.service';

/**
 * Compute and store the image embedding for a product's first image so it
 * becomes searchable by image. Fire-and-forget — never blocks the request.
 */
export async function indexProductImage(productId: string, imageUrl?: string | null): Promise<void> {
  if (!imageUrl) return;
  try {
    const embedding = await embedImageUrl(imageUrl);
    if (embedding) {
      await Product.findByIdAndUpdate(productId, { imageEmbedding: embedding });
      console.log(`🔎 [image-search] indexed product ${productId}`);
    }
  } catch (err) {
    console.error(`[image-search] failed to index ${productId}:`, (err as Error).message);
  }
}

export async function tryCreateEscrow(opts: {
  productId:        string;
  productName:      string;
  description:      string;
  price:            number;
  stock:            number;
  imageUrl?:        string | null;
  whoPays:          'buyer' | 'seller' | 'both';
  maxDelivery:      number;
  deliveryTimeline: 'hours' | 'days' | 'minutes';
  paylukCustomerId: string;
}): Promise<{ escrowId: string; paymentToken: string } | null> {
  try {
    const result = await createPaymentLink({
      amount:           opts.price,
      purpose:          opts.productName,
      description:      opts.description,
      whoPays:          opts.whoPays,
      maxDelivery:      opts.maxDelivery,
      deliveryTimeline: opts.deliveryTimeline,
      totalQuantity:    opts.stock,
      imageUrl:         opts.imageUrl ?? null,
      customerId:       opts.paylukCustomerId,
    });

    await Product.findByIdAndUpdate(opts.productId, {
      paylukEscrowId:     result.escrowId,
      paylukPaymentToken: result.paymentToken,
    });

    console.log(`✅ [Payluk] Escrow created for "${opts.productName}" (${opts.productId}):`, result.escrowId);
    return { escrowId: result.escrowId, paymentToken: result.paymentToken };

  } catch (err) {
    const msg = err instanceof PaylukError
      ? `Payluk ${err.statusCode}: ${err.message}`
      : String(err);
    console.error(`⚠️  [Payluk] Escrow failed for "${opts.productName}" (${opts.productId}) — ${msg}`);
    return null;
  }
}

/**
 * POST /products/image-search  { imageUrl }
 * Embeds the query image and returns the visually-closest products via Atlas
 * Vector Search over the stored product image embeddings.
 */
export const imageSearchProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { imageUrl, limit } = req.body ?? {};
  if (!imageUrl || typeof imageUrl !== 'string') {
    res.status(400).json({ success: false, message: 'imageUrl is required' });
    return;
  }

  const queryVector = await embedImageUrl(imageUrl);
  if (!queryVector) {
    res.status(502).json({ success: false, message: 'Could not process that image. Try another one.' });
    return;
  }

  const numCandidates = 100;
  const topK = Math.min(Math.max(Number(limit) || 20, 1), 50);

  const results = await Product.aggregate([
    {
      $vectorSearch: {
        index: 'product_image_index',
        path: 'imageEmbedding',
        queryVector,
        numCandidates,
        limit: topK,
      },
    },
    {
      $project: {
        name: 1, price: 1, description: 1, category: 1, media: 1, stock: 1,
        business: 1, averageRating: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  res.status(200).json({ success: true, total: results.length, products: results });
});

export const createProduct = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

  const business = await Business.findOne({ owner: userId });
  if (!business) { res.status(403).json({ success: false, message: 'Business profile required.' }); return; }

  const { name, category, description, price, stock, size, media, whoPays, maxDelivery, deliveryTimeline } = req.body;

  const product = await Product.create({
    business: business._id,
    name,
    category: category || 'General',
    description,
    price,
    stock,
    size,
    media: media ?? [],
  });

  const user = await User.findById(userId).select('paylukCustomerId');
  if (!user?.paylukCustomerId) {
    await Product.findByIdAndDelete(product._id);
    res.status(403).json({ success: false, code: 'PAYLUK_SETUP_REQUIRED', message: 'Payment profile required to list products. Please complete your Payluk setup.' });
    return;
  }

  // Store a template escrow on the product for reference (not used for buyer checkout).
  // Each buyer checkout creates its own fresh escrow at order time.
  tryCreateEscrow({
    productId:        product._id.toString(),
    productName:      name,
    description,
    price,
    stock,
    imageUrl:         media?.[0] ?? null,
    whoPays:          whoPays || 'buyer',
    maxDelivery:      maxDelivery ?? 3,
    deliveryTimeline: deliveryTimeline || 'days',
    paylukCustomerId: user.paylukCustomerId,
  }).catch(() => {});

  // Index the product image for AI image search (fire-and-forget).
  indexProductImage(product._id.toString(), media?.[0] ?? null).catch(() => {});

  trackEvent({
    targetId: userId,
    targetModel: 'User',
    type: 'ACTIVITY',
    activityData: { action: 'PRODUCT_CREATE', description: `You added ${name} to your inventory` },
  }).catch(() => {});

  res.status(201).json({ success: true, product, message: 'Product saved to inventory' });
});

// ─── Update ───────────────────────────────────────────────────────────────────

export const updateProduct = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId    = getAuthUserId(req);
  const { id }    = req.params;

  const business = await Business.findOne({ owner: userId });
  if (!business) { res.status(403).json({ success: false, message: 'Business profile required.' }); return; }

  const product = await Product.findOneAndUpdate(
    { _id: id, business: business._id },
    { $set: req.body },
    { new: true, runValidators: true },
  );

  if (!product) { res.status(404).json({ success: false, message: 'Product not found' }); return; }

  // Re-index the image embedding when the media changed.
  if (req.body?.media) {
    indexProductImage(product._id.toString(), product.media?.[0] ?? null).catch(() => {});
  }

  trackEvent({
    targetId: userId!,
    targetModel: 'User',
    type: 'ACTIVITY',
    activityData: { action: 'PRODUCT_UPDATE', description: `You updated product: ${product.name}` },
  }).catch(() => {});

  res.json({ success: true, data: product });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

export const deleteProduct = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  const { id } = req.params;

  const business = await Business.findOne({ owner: userId });
  if (!business) { res.status(403).json({ success: false, message: 'Business profile required.' }); return; }

  const product = await Product.findOneAndDelete({ _id: id, business: business._id });
  if (!product) { res.status(404).json({ success: false, message: 'Product not found or not yours' }); return; }

  // Remove associated posts
  const { Post } = await import('@/models/post-model');
  await Post.deleteMany({ product: id });

  trackEvent({
    targetId: userId!,
    targetModel: 'User',
    type: 'ACTIVITY',
    activityData: { action: 'PRODUCT_DELETE', description: `You deleted product: ${product.name}` },
  }).catch(() => {});

  res.json({ success: true, message: 'Product and its posts deleted' });
});

// ─── My Products ──────────────────────────────────────────────────────────────

export const getMyProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId   = getAuthUserId(req);
  const business = await Business.findOne({ owner: userId });

  if (!business) { res.json({ success: true, products: [] }); return; }

  const products = await Product.find({ business: business._id }).sort({ createdAt: -1 });
  res.json({ success: true, products });
});

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const getProductCatalog = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const currentUserId = getAuthUserId(req);
  const { businessId, restrict, page = '1', category } = req.query;

  const p     = parseInt(page as string) || 1;
  const limit = 15;
  const skip  = (p - 1) * limit;

  const query: any = {};
  if (restrict === 'true' && businessId) {
    query.business = new Types.ObjectId(businessId as string);
  }
  // Optional server-side category filter (so the storefront can filter across
  // the whole catalog, not just the page already loaded).
  if (category && category !== 'All') {
    query.category = category as string;
  }

  let wishlistProductIds = new Set<string>();
  if (currentUserId) {
    const entries = await Wishlist.find({ user: currentUserId }).select('product');
    wishlistProductIds = new Set(entries.map(w => w.product.toString()));
  }

  const products = await Product.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate({ path: 'business', select: '_id businessName businessLogo isVerified owner slug' })
    .lean();

  const formatted = products.map((product: any) => ({
    ...product,
    type:          'PRODUCT',
    authorId:      product.business?._id,
    displayName:   product.business?.businessName,
    displayAvatar: product.business?.businessLogo,
    businessSlug:  product.business?.slug,
    isVerified:    product.business?.isVerified || false,
    // Does the requester own this product (owns the business that posted it)?
    isOwner:       !!currentUserId && product.business?.owner?.toString() === currentUserId,
    likesCount:    product.likes?.length || 0,
    isLiked:       currentUserId ? product.likes?.some((id: any) => id.toString() === currentUserId) : false,
    isWishlisted:  wishlistProductIds.has(product._id.toString()),
  }));

  res.json({ success: true, posts: formatted });
});

// ─── Details ─────────────────────────────────────────────────────────────────

export const getProductDetails = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id            = req.params.id as string;
  const currentUserId = getAuthUserId(req);

  if (!Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: 'Invalid Product ID' });
    return;
  }

  const [product, relatedProducts] = await Promise.all([
    Product.findById(id)
      .populate('business', '_id businessName businessLogo isVerified owner slug')
      .lean(),
    // related query depends on the product's category, fetched concurrently
    Product.findById(id).select('category').lean().then(p =>
      p ? Product.find({ category: p.category, _id: { $ne: id } })
            .limit(4).select('name price media category stock').lean()
        : [],
    ),
  ]);

  if (!product) { res.status(404).json({ message: 'Product not found' }); return; }

  const isLiked = currentUserId
    ? product.likes?.some((id: any) => id.toString() === currentUserId)
    : false;

  let isWishlisted = false;
  if (currentUserId) {
    const entry = await Wishlist.findOne({ user: new Types.ObjectId(currentUserId), product: product._id });
    isWishlisted = !!entry;
  }

  // Does the requester own this product? (they own the business that posted it)
  const businessOwnerId = (product.business as any)?.owner?.toString();
  const isOwner = !!currentUserId && businessOwnerId === currentUserId;

  res.status(200).json({
    success: true,
    product: {
      ...product,
      isLiked,
      isWishlisted,
      isOwner,
      likesCount:    product.likes?.length || 0,
      authorId:      (product.business as any)?._id,
      displayName:   (product.business as any)?.businessName,
      displayAvatar: (product.business as any)?.businessLogo,
    },
    relatedProducts,
  });
});

// ─── Categories ───────────────────────────────────────────────────────────────

export const getProductCategories = (_req: Request, res: Response): void => {
  res.status(200).json({ success: true, data: PRODUCT_CATEGORIES });
};

// ─── Setup Escrow (retroactive) ───────────────────────────────────────────────

export const setupProductEscrow = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

  const { id: productId } = req.params;

  const [user, product] = await Promise.all([
    User.findById(userId).select('paylukCustomerId'),
    Product.findById(productId),
  ]);

  if (!user?.paylukCustomerId) {
    res.status(422).json({
      success: false,
      code: 'PAYLUK_PROFILE_REQUIRED',
      message: 'Set up your payment profile before enabling product purchases.',
    });
    return;
  }

  if (!product) { res.status(404).json({ success: false, message: 'Product not found' }); return; }

  const business = await Business.findOne({ owner: userId });
  if (!business || product.business.toString() !== business._id.toString()) {
    res.status(403).json({ success: false, message: 'Not your product' });
    return;
  }

  const result = await tryCreateEscrow({
    productId:        product._id.toString(),
    productName:      product.name,
    description:      product.description ?? product.name,
    price:            product.price,
    stock:            product.stock,
    imageUrl:         product.media?.[0] ?? null,
    whoPays:          'buyer',
    maxDelivery:      3,
    deliveryTimeline: 'days',
    paylukCustomerId: user.paylukCustomerId,
  });

  if (!result) {
    res.status(502).json({ success: false, message: 'Escrow creation failed. Please try again.' });
    return;
  }

  res.status(200).json({
    success: true,
    message: 'Product is now available for purchase.',
    paylukEscrowId:     result.escrowId,
    paylukPaymentToken: result.paymentToken,
  });
});
