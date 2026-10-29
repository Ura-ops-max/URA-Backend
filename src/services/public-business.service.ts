/**
 * The public shop page data (ura.com.ng/<slug>): the shop, its owner's public
 * profile, recent posts and counts. Used by GET /businesses/:slug and by the
 * page-builder (so the app shows a built page straight away). Visitors get no
 * street address or map position unless the shop chose to show them.
 */
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import { Post } from '@/models/post-model';
import { publicBusiness, countShopProducts } from '@/utils/business-public.utils';

export async function publicBusinessPayload(slug: string, viewerId: string | null) {
  const business = await Business.findOne({ slug: slug.toLowerCase() });
  if (!business) return null;

  const owner = await User.findById(business.owner).select(
    'firstName lastName username profilePicture'
  );

  const [posts, postCount, productCount] = await Promise.all([
    Post.find({ author: business._id, authorType: 'Business' }).sort({ createdAt: -1 }).limit(10),
    Post.countDocuments({ author: business._id, authorType: 'Business' }),
    countShopProducts(business._id),
  ]);

  const loggedInUserId = viewerId;
  const isOwner = !!loggedInUserId && String(business.owner) === loggedInUserId;
  let isFollowing = false;
  let isBookmarked = false;
  if (loggedInUserId) {
    isFollowing = business.followers.some(id => id.toString() === loggedInUserId);
    const loggedInUser = await User.findById(loggedInUserId).select('bookmarkedBusinesses');
    isBookmarked = loggedInUser
      ? loggedInUser.bookmarkedBusinesses.some(
          id => id.toString() === (business._id as any).toString()
        )
      : false;
  }

  return {
    business: publicBusiness(business, isOwner),
    owner,
    related: {
      isFollowing,
      isBookmarked,
      isOwner,
      recentPosts: posts,
      counts: {
        posts: postCount,
        products: productCount,
        followers: business.followers.length,
      },
    },
    // Lets the frontend know whether the visitor needs to sign in to act
    // (order, chat, review) vs. just browsing.
    viewerAuthenticated: Boolean(loggedInUserId),
  };
}
