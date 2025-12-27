import express from 'express';
import * as reviewController from '@/controllers/reviews.controller';
import { requireAuth } from '@/middleware/passport-auth';

const router = express.Router();

// Publicly viewable
router.get('/item/:itemId', reviewController.getItemReviews);

// Protected Actions
router.use(requireAuth);

router.post('/', reviewController.createReview);
router.patch('/:id', reviewController.updateReview);
router.delete('/:id', reviewController.deleteReview);

router.post('/:id/like', reviewController.toggleLikeReview);
router.post('/:id/dislike', reviewController.toggleDislikeReview);

export default router;