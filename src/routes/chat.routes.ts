// src/routes/chat.route.ts (Existing routes and the new route)

import { Router } from 'express';
import { requireAuth } from '@/middleware/auth';
import { 
    createOrGetConversation, // Renamed for clarity
    getMessages,             // Renamed for clarity
    getConversationList      // <-- New Controller Import
} from '@/controllers/chat.controller'; 
// Assuming all controller logic is now moved to chat.controller.ts

const router = Router();

// Route to get all conversations for the list view (THE NEW ROUTE)
router.get('/conversations/list', requireAuth, getConversationList);

// Create or get conversation between user and business (Existing)
router.post('/conversations', requireAuth, createOrGetConversation);

// Get messages for a conversation (Existing)
router.get('/conversations/:id/messages', requireAuth, getMessages);

export default router;