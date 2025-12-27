
import { Request, Response } from 'express';
import { User } from '@/models/user-model';
import { Post } from '../models/post-model';
import { Business } from '../models/business-model';
import { asyncHandler } from '@/middleware/errorHandler';

export const getMyBookmarks = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { type } = req.query; // 'Post' or 'Business'
  const userId = (req as any).user?._id;

  if (!userId) {
    res.status(401).json({ message: "User not authenticated" });
    return;
  }

  const isPost = type === 'Post';
  const bookmarkField = isPost ? 'bookmarkedPosts' : 'bookmarkedBusinesses';

  // 1. Create a base population object
  const populationOptions: any = {
    path: bookmarkField,
  };

  // 2. Only add the nested 'populate' key if it's a Post
  // This avoids passing 'undefined' and keeps TypeScript happy
  if (isPost) {
    populationOptions.populate = [
      {
        path: 'author',
        select: '_id businessName firstName lastName profilePicture businessLogo isVerified'
      },
      {
        path: 'product'
      }
    ];
  }

  // 3. Execute the query
  const userWithBookmarks = await User.findById(userId)
    .populate(populationOptions)
    .lean();

  if (!userWithBookmarks) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  // Access the dynamic field safely
  const rawResults = (userWithBookmarks as any)[bookmarkField] || [];

  // 4. Format for the frontend
  const formattedResults = rawResults.map((item: any) => {
    if (isPost) {
      const isBusinessAuthor = item.authorType === 'Business';
      return {
        ...item,
        type: item.product ? 'PRODUCT' : 'SOCIAL',
        authorId: item.author?._id,
        displayName: isBusinessAuthor ? item.author?.businessName : `${item.author?.firstName} ${item.author?.lastName}`,
        displayAvatar: item.author?.businessLogo || item.author?.profilePicture,
        isVerified: item.author?.isVerified || false,
        isBookmarked: true
      };
    }
    return {
      ...item,
      isBookmarked: true
    };
  });

  res.status(200).json(formattedResults);
});