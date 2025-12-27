import { Router } from 'express';
import * as chatController from '@/controllers/chat.controller';
import { requireAuth } from '@/middleware/auth'; // Your passport/auth middleware

const router = Router();

// All chat routes should be protected by authentication
router.use(requireAuth);

// 1. Access/Create a conversation (The "Entry Point")
// POST /api/v1/conversations
router.post('/', chatController.accessConversation);

// 2. Get the list of conversations for a specific Tab (The "Sidebar")
// GET /api/v1/conversations?profileId=XXXXX
router.get('/', chatController.getConversations);

// 3. Get messages for a specific conversation
// GET /api/v1/conversations/:conversationId/messages?profileId=XXXXX
router.get('/:conversationId/messages', chatController.getMessages);

// 4. Send a new message
// POST /api/v1/conversations/messages
router.post('/messages', chatController.sendMessage);

export default router;