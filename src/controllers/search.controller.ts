import { Request, Response } from 'express';
import { Business } from '@/models/business-model';
import { User } from '@/models/user-model';
import { Post } from '@/models/post-model';
import { Product } from '@/models/product-model';
import { SearchHistory } from '../models/search-model';


const getAuthUserId = (req: Request): string | null => {
    const user = (req as any).user;
    const id = user?._id || user?.id || user?.userId;
    return id ? id.toString() : null;
};


export const globalSearch = async (req: Request, res: Response) => {
    try {
        // FIX 1: Merge req.query and req.body so the backend catches the category 
        // sent by your frontend's POST request
        const params = { ...req.query, ...(req as any).body };

        const {
            q,
            type = 'all',
            city,
            category,
            minPrice,
            maxPrice,
            tags,
            isBusiness,
            inStock,
            openNow, 
            rating   
        } = params;

        const queryStr = String(q || "");
        const regex = { $regex: queryStr, $options: 'i' };
        const results: any = {};

        // --- 1. BUSINESS SEARCH LOGIC ---
        if (type === 'all' || type === 'business') {
            let bizQuery: any = {
                $or: [{ businessName: regex }, { about: regex }, { tagline: regex }, { category: regex }]
            };

            // FIX 2: This is now uncommented! It forces businesses to match the category.
            if (category) {
                bizQuery.category = category;
            }
     

            if (city) bizQuery['address.city'] = { $regex: city, $options: 'i' };

            if (rating) {
                bizQuery.averageRating = { $gte: Number(rating) };
            }

            if (openNow === 'true') {
                const now = new Date();
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const currentDay = days[now.getDay()];
                const currentTime = now.getHours().toString().padStart(2, '0') + ":" +
                    now.getMinutes().toString().padStart(2, '0');

                bizQuery.operatingHours = {
                    $elemMatch: {
                        day: currentDay,
                        open: { $lte: currentTime },
                        close: { $gte: currentTime },
                        isClosed: { $ne: true }
                    }
                };
            }

            // Added a sort so highest rated businesses appear first when filtering by rating
            results.businesses = await Business.find(bizQuery)
                .sort(rating ? { averageRating: -1 } : { createdAt: -1 })
                .limit(type === 'all' ? 4 : 20);
        }

        // --- 2. USER SEARCH LOGIC ---
        if (type === 'all' || type === 'user') {
            let userQuery: any = {
                $or: [{ firstName: regex }, { lastName: regex }, { username: regex }]
            };
            if (isBusiness === 'true') userQuery.isBusinessOwner = true;
            if (isBusiness === 'false') userQuery.isBusinessOwner = false;

            results.users = await User.find(userQuery).limit(type === 'all' ? 4 : 20);
        }

        // --- 3. PRODUCT SEARCH LOGIC ---
        if (type === 'all' || type === 'product') {
            let prodQuery: any = {
                $or: [{ name: regex }, { description: regex }, { category: regex }]
            };

            if (category) prodQuery.category = category;

            // NEW: Also filter products by rating!
            if (rating) {
                prodQuery.averageRating = { $gte: Number(rating) };
            }

            if (minPrice || maxPrice) {
                prodQuery.price = {};
                if (minPrice) prodQuery.price.$gte = Number(minPrice);
                if (maxPrice) prodQuery.price.$lte = Number(maxPrice);
            }

            if (inStock === 'true') {
                prodQuery.stock = { $gt: 0 };
            }

            results.products = await Product.find(prodQuery)
                .populate('business', 'businessName businessLogo')
                .sort(rating ? { averageRating: -1 } : { createdAt: -1 })
                .limit(type === 'all' ? 4 : 20);
        }

        // --- 4. POST SEARCH LOGIC ---
        if (type === 'all' || type === 'post') {
            let postQuery: any = {
                $or: [
                    { caption: regex },
                    { tags: { $in: [new RegExp(queryStr, 'i')] } }
                ]
            };

            if (tags) {
                const tagArray = String(tags).split(',');
                postQuery.tags = { $all: tagArray };
            }

            results.posts = await Post.find(postQuery)
                .populate('author') // Mongoose uses refPath automatically here
                .populate('product') // Populate linked products if any
                .limit(type === 'all' ? 4 : 20);
        }

        res.status(200).json({ success: true, data: results });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};




export const saveToHistory = async (req: Request, res: Response) => {
    try {
        const { query } = req.body;
        if (!query || query.length < 2) return res.sendStatus(400);

        await SearchHistory.findOneAndUpdate(
            { userId: getAuthUserId(req), query: query.trim() },
            { createdAt: Date.now() },
            { upsert: true, new: true }
        );

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false }); // add return
    }
};

// Add to controllers/search.controller.ts
export const getRecentSearches = async (req: Request, res: Response) => {
    try {
        const history = await SearchHistory.find({ userId: getAuthUserId(req) })
            .sort({ createdAt: -1 })
            .limit(10);

        res.status(200).json({ success: true, data: history });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};


export const deleteRecentSearch = async (req: Request, res: Response) => {
    await SearchHistory.deleteOne({ _id: req.params.id, userId: getAuthUserId(req) });
    res.status(200).json({ success: true });
};

export const clearAllRecent = async (req: Request, res: Response) => {
    await SearchHistory.deleteMany({ userId: getAuthUserId(req) });
    res.status(200).json({ success: true });
};