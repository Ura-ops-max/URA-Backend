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
} from '@/controllers/log.controller'; 
import { requireAuth } from '@/middleware/passport-auth';

// Apply protection to all notification routes
router.use(requireAuth);

/**
 * NOTIFICATION ROUTES
 */

// 1. Fetching Data
router.get('/notifications', getNotifications);
router.get('/notifications/unread-count', getUnreadCount);

// 2. Marking as Read
// Supports: 
// - PATCH /notifications/mark-read (Mark All)
// - PATCH /notifications/mark-read/:id (Mark Single)
// - PATCH /notifications/mark-read (with { ids: [] } in body for Bulk)
router.patch('/notifications/mark-read/:id?', markAsRead); 

// 3. Deleting / Clearing
router.delete('/notifications/clear-all', clearAllNotifications);

// Supports:
// - DELETE /notifications/:id (Delete Single)
// - DELETE /notifications (with { ids: [] } in body for Bulk)
router.delete('/notifications/:id?', deleteNotification);

/**
 * ACTIVITY ROUTES (Audit Logs)
 */
router.get('/activities', getActivities);
router.delete('/activities/clear-all', clearAllActivities);

export default router;