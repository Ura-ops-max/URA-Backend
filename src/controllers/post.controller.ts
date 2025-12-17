import { asyncHandler } from '@/middleware/errorHandler';
import { Post, PostType } from '@/models/post-model';
import { Request, Response, NextFunction } from 'express';
import { Business } from '@/models/business-model';
import { Types } from 'mongoose';

export const getUnifiedFeed = asyncHandler(async (req: Request, res: Response) => {
  const feed = await Post.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .populate({
      path: 'author',
      select: 'username profilePicture firstName lastName businessName profileImage'
    });

  // Map the data so the Frontend gets a consistent "Display Name"
  const formattedFeed = feed.map((post: any) => {
    const isBusiness = post.authorType === 'Business';
    const author = post.author;

    return {
      ...post._doc,
      displayName: isBusiness 
        ? author.businessName 
        : `${author.firstName} ${author.lastName}`,
      displayAvatar: isBusiness 
        ? author.profileImage 
        : author.profilePicture
    };
  });

  res.json({ success: true, posts: formattedFeed });
});


export const createPost = asyncHandler(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const userId = (req.user as any)._id; // Cast user to get ID
  const { type } = req.body;

  // Use Types.ObjectId to avoid Type mismatch errors
  let authorId: Types.ObjectId = userId;
  let authorType: 'User' | 'Business' = 'User';

  // 1. Logic for Products
  if (type === PostType.PRODUCT) {
    const business = await Business.findOne({ owner: userId });
    
    if (!business) {
      res.status(403).json({ 
        message: "You must create a business profile before uploading products." 
      });
      return; // Return nothing (void) after sending response
    }
    
    authorId = business._id as Types.ObjectId;
    authorType = 'Business';
  } 
  
  // 2. Logic for standard Posts
  else {
    const business = await Business.findOne({ owner: userId });
    if (business) {
      authorId = business._id as Types.ObjectId;
      authorType = 'Business';
    }
  }

  // 3. Create the document
  const post = await Post.create({
    ...req.body,
    author: authorId,
    authorType: authorType
  });

  res.status(201).json({
    status: 'success',
    data: post
  });

  // Explicitly return nothing to satisfy the Promise<void> type
  return; 
});

// import { eventEmitter } from '@/services/event-emitter.services'; // NEW IMPORT

// export const toggleBookmark = asyncHandler(async (req: Request, res: Response) => {
//     const userId = (req as unknown as { user: { id: string } }).user.id;
//     const postId = req.params.postId;

//     // ... Primary action logic here ...
//     const post = await Post.findById(postId).select('author'); 

//     if (post) {
//         // 🚨 Fire the event! The controller does NOT care how the logging is done.
//         eventEmitter.emit('activityLogged', {
//             actorId: userId,
//             actionType: 'bookmark',
//             targetModel: 'Post',
//             targetId: postId,
//             targetOwnerId: post.author.toString(),
//         });
//     }

//     res.json({ success: true, message: 'Bookmark toggled.' });
// });