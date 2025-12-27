import { Router } from 'express';
import { 
  globalSearch, 
  saveToHistory, 
  getRecentSearches, 
  deleteRecentSearch, 
  clearAllRecent 
} from '../controllers/search.controller';
import { requireAuth } from '../middleware/passport-auth';

const router = Router();

// Every search route should be protected so we can track history per user
router.use(requireAuth);

/**
 * @route   GET /api/v1/search
 * @desc    Live search for Businesses, Users, Products, and Posts
 */
router.get('/', globalSearch);

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