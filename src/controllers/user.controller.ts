import { Request, Response } from 'express';
import { User } from '@/models/user-model';
import { AuthenticationError, NotFoundError } from '@/utils/errors';
import { asyncHandler } from '@/middleware/errorHandler';
import { HTTP_STATUS } from '@/constants';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';
import { Post }  from '@/models/post-model';
import { Product } from '@/models/product-model';
import * as userService from '@/services/user.service';

const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

export const getCurrentUser = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);

  if (!userId) {
    throw new AuthenticationError('User not authenticated');
  }

  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) {
    throw new AuthenticationError('User not found');
  }

  const [posts, businesses] = await Promise.all([
    Post.find({ author: userId })
      .sort({ createdAt: -1 })
      .limit(10),
    Business.find({ owner: userId }).select(
      'businessName businessLogo businessCover followers likes category'
    ),
  ]);

  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: 'User retrieved successfully',
    user,
    related: {
      business_id: businesses[0]?._id || null,

      businesses,
      recentPosts: posts,
      counts: {
        posts: await Post.countDocuments({ author: userId }),
        followers: user.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) throw new AuthenticationError('User not authenticated');
  const user = await userService.updateUserProfile(userId, req.body);
  res.status(200).json({ success: true, user });
});

export const updateBusiness = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) throw new AuthenticationError('User not authenticated');

  const {
    businessName, category, about, phone, website,
    fullAddress, businessLogo, businessCover, operatingHours
  } = req.body;

  const updateData = {
    businessName,
    category,
    about,
    businessLogo,
    businessCover,
    contact: { phone, website },
    address: { fullAddress },
    operatingHours
  };

  const business = await Business.findOneAndUpdate(
    { owner: userId },
    { $set: updateData },
    { new: true, runValidators: true }
  );

  if (!business) throw new NotFoundError('Business profile not found');

  // 🚨 TRACK EVENT: Business Info Updated
  await trackEvent({
      targetId: userId,
      targetModel: 'User',
      type: 'ACTIVITY',
      activityData: {
          action: 'BUSINESS_UPDATE',
          description: `You updated the business profile for ${business.businessName}`,
          metadata: {ip: req.ip, userAgent: req.headers['user-agent']}
      }
  });

  res.status(200).json({ success: true, business });
});

export const convertToBusiness = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) throw new AuthenticationError('User not authenticated');

  try {
    await userService.convertUserToBusiness(userId);
    res.status(200).json({ success: true, message: 'Account upgraded successfully.' });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

export const getUserProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) throw new NotFoundError('User not found');

  const loggedInUserId = getAuthUserId(req);
  const loggedInUser = await User.findById(loggedInUserId);

  if (!loggedInUser) {
    res.status(404).json({ success: false, message: "No Logged in User." });
    return;
  }
  const { Post } = await import('@/models/post-model');
  const business = await Business.findOne({ owner: userId });

  const [posts] = await Promise.all([
    Post.find({ author: userId }).sort({ createdAt: -1 }).limit(10),
  ]);

  const isFollowing = loggedInUserId
    ? user.followers.some(id => id.toString() === loggedInUserId)
    : false;

  const isBookmarked = loggedInUserId
    ? loggedInUser.bookmarkedBusinesses.some(id => id.toString() === user.businesses?.[0]?.toString())
    : false;

  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,
    business,
    related: {
      isFollowing,
      isBookmarked,
      recentPosts: posts,
      counts: {
        posts: await Post.countDocuments({ author: userId }),
        followers: user.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});

export const getBusinessProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { businessId } = req.params;
  const loggedInUserId = getAuthUserId(req);

  const business = await Business.findById(businessId);
  if (!business) throw new NotFoundError('Business not found');

  const user = await User.findById(business.owner).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );
  if (!user) throw new NotFoundError('Business owner not found');

  const loggedInUser = loggedInUserId ? await User.findById(loggedInUserId) : null;

  const { Post } = await import('@/models/post-model');

  const [posts, postCount] = await Promise.all([
    Post.find({ author: businessId, authorType: 'Business' }).sort({ createdAt: -1 }).limit(10),
    Post.countDocuments({ author: businessId, authorType: 'Business' })
  ]);

  const isFollowing = loggedInUserId
    ? business.followers.some(id => id.toString() === loggedInUserId)
    : false;

  const isBookmarked = loggedInUser
    ? loggedInUser.bookmarkedBusinesses.some(id => id.toString() === businessId)
    : false;

  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,
    business,
    related: {
      isFollowing,
      isBookmarked,
      recentPosts: posts,
      counts: {
        posts: postCount,
        followers: business.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});

export const getFollowList = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params;
  const { type } = req.query;
  const currentUserId = getAuthUserId(req);

  let target: any = await User.findById(targetId)
    .populate({
      path: type === 'followers' ? 'followers' : 'followingUsers followingBusinesses',
      select: '_id firstName lastName username profilePicture businessName businessLogo followers'
    })
    .lean();

  let isBusinessTarget = false;

  if (!target) {
    target = await Business.findById(targetId)
      .populate({
        path: 'followers',
        select: '_id firstName lastName username profilePicture'
      })
      .lean();

    if (target) isBusinessTarget = true;
  }

  if (!target) {
    res.status(404).json({ message: "Entity not found" });
    return;
  }

  if (isBusinessTarget && type === 'following') {
    res.json({ success: true, users: [], message: "Businesses do not follow entities." });
    return;
  }

  let rawList: any[] = [];

  if (type === 'followers') {
    rawList = (target.followers || []).map((u: any) => ({ ...u, kind: 'User' }));
  } else {
    const users = (target.followingUsers || []).map((u: any) => ({ ...u, kind: 'User' }));
    const businesses = (target.followingBusinesses || []).map((b: any) => ({ ...b, kind: 'Business' }));
    rawList = [...users, ...businesses];
  }

  const formattedList = rawList.map((item: any) => {
    const isItemBusiness = item.kind === 'Business';

    return {
      _id: item._id,
      firstName: isItemBusiness ? item.businessName : item.firstName,
      lastName: isItemBusiness ? '' : item.lastName,
      username: isItemBusiness ? 'Business Account' : (item.username || 'user'),
      avatar: isItemBusiness ? item.businessLogo : item.profilePicture,
      isBusiness: isItemBusiness,
      isFollowing: currentUserId
        ? item.followers?.some((id: any) => id.toString() === currentUserId.toString())
        : false
    };
  });

  res.json({ success: true, users: formattedList });
});

export const updateShippingAddress = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) throw new AuthenticationError('User not authenticated');
  const shippingAddress = await userService.updateShippingAddress(userId, req.body);
  res.status(200).json({ success: true, shippingAddress });
});

export const getWishlistProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = (req as any).user?._id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;

  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const products = await Product.find({ likes: userId })
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('business', '_id businessName businessLogo isVerified')
    .lean();

  const formattedProducts = products.map((product: any) => ({
    ...product,
    type: 'PRODUCT',
    authorId: product.business?._id,
    displayName: product.business?.businessName,
    displayAvatar: product.business?.businessLogo,
    isVerified: product.business?.isVerified || false,
    isLiked: true,
    likesCount: product.likes?.length || 0,
  }));

  res.status(200).json(formattedProducts);
});