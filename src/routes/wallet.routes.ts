import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '@/middleware/passport-auth';
import {
  confirmWithdrawal,
  getBanks,
  getEscrows,
  getTransactions,
  getWallet,
  startWithdrawal,
  verifyAccount,
} from '@/controllers/payment.controller';

// The user's Payluk wallet, through URA's backend (the browser never calls Payluk).
const router = Router();
router.use(requireAuth);

// Money-moving and lookup calls: a modest per-user/IP cap.
const walletWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/', getWallet); // GET  /wallet               balance
router.get('/transactions', getTransactions); // GET  /wallet/transactions  history
router.get('/escrows', getEscrows); // GET  /wallet/escrows?type=buy|sales
router.get('/banks', getBanks); // GET  /wallet/banks
router.post('/verify-account', walletWriteLimiter, verifyAccount); // POST /wallet/verify-account
router.post('/withdraw', walletWriteLimiter, startWithdrawal); // POST /wallet/withdraw (step 1)
router.post('/withdraw/confirm', walletWriteLimiter, confirmWithdrawal); // POST /wallet/withdraw/confirm (step 2, OTP)

export default router;
