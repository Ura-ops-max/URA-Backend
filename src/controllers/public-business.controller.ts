import { Request, Response } from 'express';
import QRCode from 'qrcode';
import { asyncHandler } from '@/middleware/errorHandler';
import { HTTP_STATUS } from '@/constants';
import { NotFoundError } from '@/utils/errors';
import { Business, RESERVED_SLUGS } from '@/models/business-model';
import { User } from '@/models/user-model';
import { Post } from '@/models/post-model';
import { config } from '@/config/env.config';

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

/**
 * Public business page by slug — ura.com.ng/<slug>.
 * Uses optionalProtect (see routes file), so this works whether or not the
 * visitor is logged in. Only follow/bookmark state needs a logged-in user;
 * everything else (name, products, posts, reviews) is shown to anyone.
 */
export const getPublicBusinessBySlug = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);

  const business = await Business.findOne({ slug: slug.toLowerCase() });
  if (!business) throw new NotFoundError('Business not found');

  const owner = await User.findById(business.owner).select(
    'firstName lastName username profilePicture'
  );

  const [posts, postCount] = await Promise.all([
    Post.find({ author: business._id, authorType: 'Business' }).sort({ createdAt: -1 }).limit(10),
    Post.countDocuments({ author: business._id, authorType: 'Business' }),
  ]);

  const loggedInUserId = getAuthUserId(req);
  let isFollowing = false;
  let isBookmarked = false;
  if (loggedInUserId) {
    isFollowing = business.followers.some((id) => id.toString() === loggedInUserId);
    const loggedInUser = await User.findById(loggedInUserId).select('bookmarkedBusinesses');
    isBookmarked = loggedInUser
      ? loggedInUser.bookmarkedBusinesses.some((id) => id.toString() === (business._id as any).toString())
      : false;
  }

  res.status(HTTP_STATUS.OK).json({
    success: true,
    business,
    owner,
    related: {
      isFollowing,
      isBookmarked,
      recentPosts: posts,
      counts: {
        posts: postCount,
        followers: business.followers.length,
      },
    },
    // Lets the frontend know whether the visitor needs to sign in to act
    // (order, chat, review) vs. just browsing.
    viewerAuthenticated: Boolean(loggedInUserId),
  });
});

/**
 * Check whether a slug is available/valid before letting a business owner
 * pick one from Settings (not wired to a UI yet, but ready for it).
 */
export const checkSlugAvailability = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const normalized = slug.toLowerCase().trim();
  const valid = /^[a-z0-9-]{3,60}$/.test(normalized);
  const reserved = RESERVED_SLUGS.has(normalized);
  const taken = valid && !reserved ? Boolean(await Business.exists({ slug: normalized })) : false;

  res.status(HTTP_STATUS.OK).json({
    success: true,
    available: valid && !reserved && !taken,
    reason: !valid ? 'INVALID_FORMAT' : reserved ? 'RESERVED' : taken ? 'TAKEN' : null,
  });
});

/**
 * QR code for a business's public page, as a PNG data URL.
 * Optional ?loc=<label> tags which physical anchor location the code was
 * printed for (e.g. "wuse2"), so scans can later be attributed per location —
 * the code just carries it as a query param for now; scan-event logging is a
 * separate follow-up.
 */
export const getBusinessQrCode = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const slug = String(req.params.slug);
  const { loc } = req.query;

  const business = await Business.findOne({ slug: slug.toLowerCase() }).select('_id slug');
  if (!business) throw new NotFoundError('Business not found');

  const targetUrl = new URL(`/${business.slug}`, config.frontend.url);
  if (loc && typeof loc === 'string') targetUrl.searchParams.set('loc', loc);

  const dataUrl = await QRCode.toDataURL(targetUrl.toString(), {
    width: 512,
    margin: 2,
  });

  res.status(HTTP_STATUS.OK).json({
    success: true,
    url: targetUrl.toString(),
    qrCodeDataUrl: dataUrl,
  });
});

