import { Request, Response } from 'express';
import { Bookmark } from '@/models/bookmark.model';
import { asyncHandler } from '@/middleware/errorHandler';

export const getBookmarkList = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;

  const bookmarks = await Bookmark.find({ user: userId })
    .populate({
      path: 'targetId',
      // We populate fields that exist in both or handle them in the map
      select: 'title content username profilePicture bio firstName lastName', 
    })
    .sort({ createdAt: -1 })
    .limit(10);

  const formattedBookmarks = bookmarks.map((bm: any) => {
    const isPost = bm.targetType === 'Post';
    const target = bm.targetId;

    return {
      id: bm._id,
      // If post: use title. If user: use username or full name.
      name: isPost ? target?.title : (target?.username || `${target?.firstName} ${target?.lastName}`),
      // If post: use content snippet. If user: use bio or "User Profile".
      description: isPost 
        ? target?.content?.substring(0, 50) + '...' 
        : (target?.bio || 'View Profile'),
      avatar: isPost 
        ? `https://ui-avatars.com/api/?name=${target?.title}` // Or post thumbnail
        : (target?.profilePicture || `https://ui-avatars.com/api/?name=${target?.username}`)
    };
  });

  res.status(200).json({ success: true, bookmarks: formattedBookmarks });
});

// export const toggleBookmark = asyncHandler(async (req: Request, res: Response) => {
//   const userId = (req as any).user.id;
//   const { targetType, targetId } = req.params; // targetType is 'Post' or 'User'

//   if (!['Post', 'User'].includes(targetType)) {
//     return res.status(400).json({ message: "Invalid target type" });
//   }

//   const existing = await Bookmark.findOne({ user: userId, targetId });

//   if (existing) {
//     await Bookmark.findByIdAndDelete(existing._id);
//     return res.status(200).json({ success: true, bookmarked: false });
//   }

//   await Bookmark.create({ user: userId, targetId, targetType });
  
//   // Logic for targetOwnerId depends on type:
//   // If targetType === 'Post', fetch Post author.
//   // If targetType === 'User', targetId IS the targetOwnerId.

//   res.status(201).json({ success: true, bookmarked: true });
// });