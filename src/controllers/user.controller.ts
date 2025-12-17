import { Request, Response } from 'express';
import { User } from '@/models/user-model';

import { AuthenticationError, NotFoundError } from '@/utils/errors';
import { asyncHandler } from '@/middleware/errorHandler';
import { HTTP_STATUS } from '@/constants';
import { Business } from '@/models/business-model';
import { uploadToCloud } from '@/services/upload-service';
import { UserType } from '@/types/api.types';
import mongoose from "mongoose";


export const getCurrentUser = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = (req as any).user?.id || (req as any).user?.userId || (req as any).user?._id;

  if (!userId) {
    throw new AuthenticationError('User not authenticated');
  }

  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) {
    throw new AuthenticationError('User not found');
  }

  // Aggregate related data
  const { Post } = await import('@/models/post-model');
  const { Business } = await import('@/models/business-model');

  const [posts, businesses] = await Promise.all([
    Post.find({ business: { $in: user.businesses } })
      .sort({ createdAt: -1 })
      .limit(10),
    Business.find({ _id: { $in: user.businesses } }).select(
      'businessName profileImage coverImage followers likes category'
    ),
  ]);

  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: 'User retrieved successfully',
    user: {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      username: user.username,
      profilePicture: user.profilePicture,
      coverPicture: user.coverPicture,
      bio: user.bio,
      businessName: user.businessName,
      isBusinessOwner: user.isBusinessOwner,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      lastLoginAt: user.lastLoginAt,
      bookmarkedBusinesses: user.bookmarkedBusinesses,
      bookmarkedPosts: user.bookmarkedPosts,
      savedEvents: user.savedEvents,
      followingUsers: user.followingUsers,
      followingBusinesses: user.followingBusinesses,
      followers: user.followers,
      businesses: user.businesses,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    related: {
      businesses,
      recentPosts: posts,
      counts: {
        posts: await Post.countDocuments({ business: { $in: user.businesses } }),
        followers: user.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  // Reliable userId extraction
  const userId = req.user?._id || (req as any).user?.id;

  if (!userId) {
    throw new AuthenticationError('User not authenticated');
  }

  // Now profilePicture and coverPicture come directly from req.body as strings (URLs)
  const { 
    firstName, 
    lastName, 
    bio, 
    profilePicture, 
    coverPicture, 
    businessData 
  } = req.body;

  // Prepare the update object
  const updateData: any = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (bio) updateData.bio = bio;
  if (profilePicture) updateData.profilePicture = profilePicture;
  if (coverPicture) updateData.coverPicture = coverPicture;

  // 1. Update User
  const user = await User.findByIdAndUpdate(
    userId, 
    { $set: updateData }, 
    { new: true, runValidators: true }
  );

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // 2. Update Business (if owner and businessData is provided)
  if (user.isBusinessOwner && businessData) {
    await Business.findOneAndUpdate(
      { owner: userId }, 
      { $set: businessData },
      { new: true }
    );
  }

  res.status(200).json({ 
    success: true, 
    message: "Profile updated successfully",
    user 
  });
});

// src/controllers/business.controller.ts
export const updateBusiness = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?._id;

  // Destructure the clean JSON sent from the frontend
  const { 
    businessName, 
    category, 
    about, 
    phone, 
    website, 
    fullAddress, 
    businessLogo, 
    businessCover,
    operatingHours 
  } = req.body;

  // Map to your Mongoose Schema structure
  const updateData = {
    businessName,
    category,
    about,
    businessLogo,
    businessCover,
    contact: {
      phone,
      website
    },
    address: {
      fullAddress
    },
    operatingHours // This is already an array of {day, open, close}
  };

  const business = await Business.findOneAndUpdate(
    { owner: userId },
    { $set: updateData },
    { new: true, runValidators: true }
  );

  if (!business) {
    throw new NotFoundError('Business profile not found');
  }

  res.status(200).json({
    success: true,
    message: "Business profile updated successfully",
    business
  });
});


export const convertToBusiness = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!._id; // The '!' tells TS it's safe

  // const user = await User.findById(userId);

  const user = req.user as UserType;
  if (user?.isBusinessOwner) {
    res.status(400).json({
      success: false,
      message: "Account is already a business account."
    });
    return; // This ensures we return 'void'
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await User.findByIdAndUpdate(userId, { isBusinessOwner: true }, { session });

    // Inside convertToBusiness in user.controller.ts

    await Business.create([{
      owner: userId,
      businessName: `${user?.firstName || 'My'}'s Business`,
      about: "Update your business description here.",
      category: "Other",
      contact: { email: user?.email },
      // FIX: Provide the required coordinates array
      location: {
        type: "Point",
        coordinates: [0, 0] // [longitude, latitude] - default to null island
      }
    }], { session });

    await session.commitTransaction();

    // Do not 'return' the res object, just call the method
    res.status(200).json({
      success: true,
      message: "Account upgraded successfully."
    });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});




// controllers/user-controller.ts
export const getUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  // 1. Find the User
  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // 2. Find their Business (since it's 1-to-1)
  const { Business } = await import('@/models/business-model');
  const { Post } = await import('@/models/post-model');

  const business = await Business.findOne({ owner: userId });

  // 3. Gather Stats & Related Data
  // If they have a business, get posts for that business. 
  // If not, get posts where they are the author (depending on your post model)
  const [posts, followersCount] = await Promise.all([
    Post.find(business ? { business: business._id } : { author: userId })
      .sort({ createdAt: -1 })
      .limit(10),
    user.followers.length
  ]);

  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,
    business: business || null, // Key: returns null if no business exists
    related: {
      recentPosts: posts,
      counts: {
        posts: await Post.countDocuments(business ? { business: business._id } : { author: userId }),
        followers: user.followers.length,
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});