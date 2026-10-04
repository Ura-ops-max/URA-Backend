import { Router } from 'express';
import { optionalProtect } from '@/middleware/passport-auth';
import {
  getPublicBusinessBySlug,
  checkSlugAvailability,
  getBusinessQrCode,
} from '@/controllers/public-business.controller';

const router = Router();

// Public business page — works logged-in or logged-out.
router.get('/slug-available/:slug', checkSlugAvailability);   // GET /businesses/slug-available/:slug
router.get('/:slug/qrcode',          getBusinessQrCode);      // GET /businesses/:slug/qrcode
router.get('/:slug',                 optionalProtect, getPublicBusinessBySlug); // GET /businesses/:slug

export default router;
