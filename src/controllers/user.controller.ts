import { Request, Response } from 'express';
import { User } from '@/models/user-model';
import { AuthenticationError, NotFoundError } from '@/utils/errors';
import { asyncHandler } from '@/middleware/errorHandler';
import { HTTP_STATUS } from '@/constants';
import { Business } from '@/models/business-model';
import { eventEmitter } from '@/services/event-emitter.services';
import mongoose, { Types } from "mongoose";

/**
 * Helper to safely extract user ID
 */
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

  const { Post } = await import('@/models/post-model');

  const [posts, businesses] = await Promise.all([
    Post.find({ author: userId }) // Adjusted to check author field for consistency
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

  const { firstName, lastName, bio, profilePicture, coverPicture } = req.body;

  const updateData: any = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (bio) updateData.bio = bio;
  if (profilePicture) updateData.profilePicture = profilePicture;
  if (coverPicture) updateData.coverPicture = coverPicture;

  const user = await User.findByIdAndUpdate(
    userId, 
    { $set: updateData }, 
    { new: true, runValidators: true }
  );

  if (!user) throw new NotFoundError('User not found');

  // 🚨 EVENT LOG: Profile Update
  eventEmitter.emit('activityLogged', {
    actorId: userId,
    actionType: 'signup', // Reusing signup or could be 'update'
    targetModel: 'User',
    targetId: userId,
    targetOwnerId: userId,
  });

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

  // 🚨 EVENT LOG: Business Info Updated
  eventEmitter.emit('activityLogged', {
    actorId: userId,
    actionType: 'signup', 
    targetModel: 'User', // Logging against the user's business presence
    targetId: (business._id as Types.ObjectId).toString(),
    targetOwnerId: userId,
  });

  res.status(200).json({ success: true, business });
});

export const convertToBusiness = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) throw new AuthenticationError('User not authenticated');

  const user = await User.findById(userId);
  if (user?.isBusinessOwner) {
    res.status(400).json({ success: false, message: "Already a business account." });
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await User.findByIdAndUpdate(userId, { isBusinessOwner: true }, { session });

    const business = await Business.create([{
      owner: userId,
      businessName: `${user?.firstName || 'My'}'s Business`,
      about: "Update your business description here.",
      category: "Other",
      contact: { email: user?.email },
      location: { type: "Point", coordinates: [0, 0] }
    }], { session });

    await session.commitTransaction();

    // 🚨 EVENT LOG: Account Upgrade
    eventEmitter.emit('activityLogged', {
      actorId: userId,
      actionType: 'signup', 
      targetModel: 'User',
      targetId: (business[0]._id as Types.ObjectId).toString(),
      targetOwnerId: userId,
    });

    res.status(200).json({ success: true, message: "Account upgraded successfully." });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

export const getUserProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) throw new NotFoundError('User not found');

  const { Post } = await import('@/models/post-model');
  const business = await Business.findOne({ owner: userId });

  const [posts] = await Promise.all([
    Post.find({ author: userId }).sort({ createdAt: -1 }).limit(10),
  ]);

  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,
    business,
    related: {
      recentPosts: posts,
      counts: {
        posts: await Post.countDocuments({ author: userId }),
        followers: user.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});