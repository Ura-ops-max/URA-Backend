import express from 'express';
const router = express.Router();
import { 
  getNotifications, 
  deleteNotification, 
  clearAllNotifications,
  getUnreadCount,
  markAsRead,
  getActivities,
  clearAllActivities 
} from '@/controllers/log.controller'; // Assuming combined file
import { requireAuth } from '@/middleware/passport-auth';

// Apply protection to all log-related routes
router.use(requireAuth);

/**
 * NOTIFICATION ROUTES
 */
router.get('/notifications', getNotifications);
router.get('/notifications/unread-count', getUnreadCount);

// Mark as read (optional :id for single, no :id for all)
router.patch('/notifications/mark-read/:id?', markAsRead); 

router.delete('/notifications/clear-all', clearAllNotifications);
router.delete('/notifications/:id', deleteNotification);

/**
 * ACTIVITY ROUTES (Audit Logs)
 */
router.get('/activities', getActivities);
router.delete('/activities/clear-all', clearAllActivities);

export default router;