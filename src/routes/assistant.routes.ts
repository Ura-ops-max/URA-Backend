import { Router } from 'express';
import { assistantChat } from '@/controllers/assistant.controller';

const router = Router();

// Public: the homepage chatbot is available to logged-out visitors too.
router.post('/chat', assistantChat);

export default router;
