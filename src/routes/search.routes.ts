import { Router } from 'express';
import { 
  globalSearch, 
  saveToHistory, 
  getRecentSearches, 
  deleteRecentSearch, 
  clearAllRecent 
} from '../controllers/search.controller';
import { requireAuth, optionalProtect } from '../middleware/passport-auth';

const router = Router();

/**
 * @route   GET /api/v1/search
 * @desc    Live search for Businesses, Users, Products, and Posts.
 *          Open to signed-out visitors so they can browse before joining.
 */
router.get('/', optionalProtect, globalSearch);

// Search history is personal, so everything below needs a signed-in user.
router.use(requireAuth);

/**
 * @route   GET /api/v1/search/recent
 * @desc    Fetch the user's search history
 */
router.get('/recent', getRecentSearches);

/**
 * @route   POST /api/v1/search/history
 * @desc    Manually save a query to history (triggered on result click)
 */
router.post('/history', saveToHistory);

/**
 * @route   DELETE /api/v1/search/history/:id
 * @desc    Remove a single item from history
 */
router.delete('/history/:id', deleteRecentSearch);

/**
 * @route   DELETE /api/v1/search/history
 * @desc    Clear all search history for the user
 */
router.delete('/history', clearAllRecent);

export default router;