import { Request, Response } from 'express';
import { User } from '@/models/user-model';
import { AuthenticationError, NotFoundError } from '@/utils/errors';
import { asyncHandler } from '@/middleware/errorHandler';
import { HTTP_STATUS } from '@/constants';
import { Business } from '@/models/business-model';
import { eventEmitter } from '@/services/event-emitter.services';
import mongoose, { Types } from "mongoose";

// Define a simple interface for what a Business looks like to satisfy the ID error
interface IBusinessDoc {
  _id: Types.ObjectId;
  // add other fields if you need them for the emitter
}

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
  if (!user || user.isBusinessOwner) {
    res.status(400).json({ success: false, message: "Invalid request or already a business." });
    return;
  }

  // Simple toggle: Local = false, Production = true
  const useTx = process.env.USE_TRANSACTIONS === 'true';
  const session = useTx ? await mongoose.startSession() : null;

  try {
    if (session) session.startTransaction();

    // 1. Update User
    await User.findByIdAndUpdate(userId, { isBusinessOwner: true }, { session });

    // 2. Create Business
    const businessData = {
      owner: userId,
      businessName: `${user.firstName}'s Business`,
      about: "Update your business description here.",
      category: "Other",
      contact: { email: user.email },
      location: { type: "Point", coordinates: [0, 0] }
    };

    // Handle the difference in return types between session vs no-session
    let newBusiness;
    if (session) {
      const result = await Business.create([businessData], { session });
      newBusiness = result[0];
    } else {
      newBusiness = await Business.create(businessData);
    }

    if (session) await session.commitTransaction();

    // 🚨 Log Activity
    eventEmitter.emit('activityLogged', {
      actorId: userId,
      actionType: 'signup',
      targetModel: 'Business',
      targetId: (newBusiness._id as Types.ObjectId).toString(),
      targetOwnerId: userId,
    });

    res.status(200).json({ success: true, message: "Account upgraded successfully." });

  } catch (error) {
    if (session) await session.abortTransaction();
    throw error; // This will trigger your global error handler
  } finally {
    if (session) session.endSession();
  }
});

export const getUserProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  const user = await User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );

  if (!user) throw new NotFoundError('User not found');
  
  const loggedInUserId = getAuthUserId(req); // From your auth middleware
  
  const loggedInUser = await User.findById(loggedInUserId);

  if( !loggedInUser ){
    res.status(404).json({ success: false, message: "No Logged in User." });
    return;
  }
  const { Post } = await import('@/models/post-model');
  const business = await Business.findOne({ owner: userId });

  const [posts] = await Promise.all([
    Post.find({ author: userId }).sort({ createdAt: -1 }).limit(10),
  ]);

  // 2. Determine following status
  // Check if the target user's followers array includes the logged-in user's ID
  const isFollowing = loggedInUserId
    ? user.followers.some(id => id.toString() === loggedInUserId)
    : false;

    const isBookmarked = loggedInUserId
      ? loggedInUser.bookmarkedBusinesses.some(id => id.toString() === user.businesses[0]?.toString())
      : false;
  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,
    business,
    related: {
      isFollowing,    // <--- Add this
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

  // 1. Find the Business first
  const business = await Business.findById(businessId);
  if (!business) throw new NotFoundError('Business not found');

  // 2. Find the owner (User) of this business
  const user = await User.findById(business.owner).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes'
  );
  if (!user) throw new NotFoundError('Business owner not found');

  // 3. Fetch logged-in user for status checks (Following/Bookmarking)
  const loggedInUser = loggedInUserId ? await User.findById(loggedInUserId) : null;

  const { Post } = await import('@/models/post-model');

  // 4. Gather related data (Posts and Counts)
  const [posts, postCount] = await Promise.all([
    Post.find({ author: businessId, authorType: 'Business' }).sort({ createdAt: -1 }).limit(10),
    Post.countDocuments({ author: businessId, authorType: 'Business' })
  ]);

  // 5. Determine following/bookmark status
  // For a business, we check the business.followers array
  const isFollowing = loggedInUserId
    ? business.followers.some(id => id.toString() === loggedInUserId)
    : false;

  // Check if this business ID is in the logged-in user's bookmark list
  const isBookmarked = loggedInUser
    ? loggedInUser.bookmarkedBusinesses.some(id => id.toString() === businessId)
    : false;

  res.status(HTTP_STATUS.OK).json({
    success: true,
    user,      // The owner
    business,  // The business details
    related: {
      isFollowing,
      isBookmarked,
      recentPosts: posts,
      counts: {
        posts: postCount,
        followers: business.followers.length,
        // Since we are on a business page, 'following' usually refers to the owner's reach
        following: user.followingUsers.length + user.followingBusinesses.length,
      },
    },
  });
});

// GET /api/users/:targetId/social?type=followers|following
export const getFollowList = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { targetId } = req.params;
  const { type } = req.query; // "followers" | "following"
  const currentUserId = getAuthUserId(req);

  // 1. Determine if target is User or Business
  let target: any = await User.findById(targetId)
    .populate({
      path: type === 'followers' ? 'followers' : 'followingUsers followingBusinesses',
      select: '_id firstName lastName username profilePicture businessName businessLogo followers'
    })
    .lean();

  let isBusinessTarget = false;

  // 2. If not found in User, check Business collection
  if (!target) {
    target = await Business.findById(targetId)
      .populate({
        path: 'followers', // Businesses ONLY have followers
        select: '_id firstName lastName username profilePicture'
      })
      .lean();
    
    if (target) isBusinessTarget = true;
  }

  if (!target) {
    res.status(404).json({ message: "Entity not found" });
    return;
  }

  // 3. Logic Guard: Businesses don't "follow" anyone
  if (isBusinessTarget && type === 'following') {
    res.json({ success: true, users: [], message: "Businesses do not follow entities." });
    return;
  }

  // 4. Extract raw data based on context
  let rawList: any[] = [];

  if (type === 'followers') {
    // Both User and Business have 'followers' (which are always Users)
    rawList = (target.followers || []).map((u: any) => ({ ...u, kind: 'User' }));
  } else {
    // This part only runs for User targets (following list)
    const users = (target.followingUsers || []).map((u: any) => ({ ...u, kind: 'User' }));
    const businesses = (target.followingBusinesses || []).map((b: any) => ({ ...b, kind: 'Business' }));
    rawList = [...users, ...businesses];
  }

  // 5. Unified Transformation
  const formattedList = rawList.map((item: any) => {
    const isItemBusiness = item.kind === 'Business';
    
    return {
      _id: item._id,
      firstName: isItemBusiness ? item.businessName : item.firstName,
      lastName: isItemBusiness ? '' : item.lastName,
      username: isItemBusiness ? 'Business Account' : (item.username || 'user'),
      avatar: isItemBusiness ? item.businessLogo : item.profilePicture,
      isBusiness: isItemBusiness,
      // Check if the LOGGED-IN user is in the followers array of this specific item
      isFollowing: currentUserId 
        ? item.followers?.some((id: any) => id.toString() === currentUserId.toString()) 
        : false
    };
  });

  res.json({ success: true, users: formattedList });
});