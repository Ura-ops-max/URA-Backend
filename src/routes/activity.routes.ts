import { Router } from 'express';
import { requireAuth } from '@/middleware/auth';

import { 
getActivityList
} from '@/controllers/activity.controller'; 

const router = Router();

// Route to get all conversations for the list view (THE NEW ROUTE)
router.get('/list', requireAuth, getActivityList);

export default router;
