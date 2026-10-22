import { Request, Response } from 'express';
import { getAuthUserId } from '@/utils/request.utils';
import { PaylukError } from '@/services/payluk.service';
import * as payments from '@/services/payment.service';
import * as wallet from '@/services/wallet.service';
import { User } from '@/models/user-model';

/** Turn service and Payluk errors into plain answers for the app. */
export function sendError(res: Response, e: unknown, fallback: string): Response {
  if (e instanceof PaylukError) {
    if (e.code === 'BUSY' || e.code === 'RATE_LIMITED') {
      return res.status(503).json({
        success: false,
        code: 'PAYMENTS_BUSY',
        message: 'Payments are busy. Please try again in a moment.',
      });
    }
    if (e.code === 'BAD_REQUEST') {
      return res.status(400).json({ success: false, code: 'PAYLUK_REJECTED', message: e.message });
    }
    // 401/403/5xx/network: don't pass Payluk's internals to the browser.
    return res.status(502).json({
      success: false,
      code: 'PAYLUK_ERROR',
      message: 'Payment service problem. Please try again shortly.',
    });
  }
  const err = e as any;
  return res.status(err?.status || 500).json({
    success: false,
    ...(err?.code ? { code: err.code } : {}),
    message: err?.message || fallback,
  });
}

const userIdOf = (req: Request, res: Response): string | null => {
  const id = getAuthUserId(req);
  if (!id) res.status(401).json({ success: false, message: 'Unauthorized' });
  return id;
};

// ─── Orders ──────────────────────────────────────────────────────────────────

export const startPayment = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    const r = await payments.startPayment(String(req.params.id), userId);
    return res.status(200).json({ success: true, ...r });
  } catch (e) {
    return sendError(res, e, 'Could not start the payment');
  }
};

export const paymentStatus = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.getPaymentStatus(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not check the payment');
  }
};

export const payFromWallet = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.payFromWallet(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not pay from your wallet');
  }
};

export const confirmReceived = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.confirmReceived(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not confirm the order');
  }
};

export const openDispute = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    const file = (req as any).file as
      | { buffer: Buffer; originalname: string; mimetype: string }
      | undefined;
    const r = await payments.submitOrderDispute(
      String(req.params.id),
      userId,
      String(req.body?.message ?? ''),
      file
    );
    return res.status(200).json({ success: true, ...r });
  } catch (e) {
    return sendError(res, e, 'Could not submit the dispute');
  }
};

export const getDispute = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.getOrderDispute(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not load the dispute');
  }
};

export const claimFunds = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.claimOrderFunds(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not claim the payment');
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.cancelOrder(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not cancel the order');
  }
};

export const rejectOrder = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    return res.status(200).json({
      success: true,
      ...(await payments.rejectOrder(String(req.params.id), userId, reason)),
    });
  } catch (e) {
    return sendError(res, e, 'Could not reject the order');
  }
};

export const requestRefund = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await payments.requestRefund(String(req.params.id), userId)) });
  } catch (e) {
    return sendError(res, e, 'Could not request the refund');
  }
};

// ─── Wallet ──────────────────────────────────────────────────────────────────

/** The user's own Payluk customer id, or a clear answer when they have none. */
async function customerIdOf(
  req: Request,
  res: Response
): Promise<{ userId: string; customerId: string } | null> {
  const userId = userIdOf(req, res);
  if (!userId) return null;
  const u = await User.findById(userId).select('paylukCustomerId').lean();
  const customerId = (u as any)?.paylukCustomerId as string | undefined;
  if (!customerId) {
    res.status(409).json({
      success: false,
      code: 'PAYLUK_PROFILE_REQUIRED',
      message: 'Set up your payment profile first.',
    });
    return null;
  }
  return { userId, customerId };
}

const intQuery = (v: unknown, def: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
};

export const getWallet = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    const u = await User.findById(userId).select('paylukCustomerId').lean();
    const customerId = (u as any)?.paylukCustomerId as string | undefined;
    // No payment profile yet: an empty wallet, not an error.
    if (!customerId)
      return res.status(200).json({
        success: true,
        hasProfile: false,
        mainBalance: 0,
        escrowBalance: 0,
        currency: 'NGN',
      });
    return res
      .status(200)
      .json({ success: true, hasProfile: true, ...(await wallet.walletBalance(customerId)) });
  } catch (e) {
    return sendError(res, e, 'Could not load your wallet');
  }
};

/** The user's own money rows, with names (never references, emails or phones). */
export const getActivity = async (req: Request, res: Response) => {
  const ids = await customerIdOf(req, res);
  if (!ids) return;
  try {
    const r = await wallet.walletActivity(
      ids.userId,
      ids.customerId,
      intQuery(req.query.page, 1),
      Math.min(100, intQuery(req.query.limit, 20))
    );
    return res.status(200).json({ success: true, ...r });
  } catch (e) {
    return sendError(res, e, 'Could not load your transactions');
  }
};

/** Orders whose money is held in Buyer-Protected (sales and purchases). */
export const getHeld = async (req: Request, res: Response) => {
  const userId = userIdOf(req, res);
  if (!userId) return;
  try {
    return res.status(200).json({ success: true, orders: await wallet.heldOrders(userId) });
  } catch (e) {
    return sendError(res, e, 'Could not load held payments');
  }
};

export const getBanks = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, banks: await wallet.banks() });
  } catch (e) {
    return sendError(res, e, 'Could not load banks');
  }
};

export const verifyAccount = async (req: Request, res: Response) => {
  const ids = await customerIdOf(req, res);
  if (!ids) return;
  const accountNumber = String(req.body?.accountNumber ?? '').trim();
  const bankCode = String(req.body?.bankCode ?? '').trim();
  if (!/^\d{10}$/.test(accountNumber) || !bankCode) {
    return res
      .status(400)
      .json({ success: false, message: 'Enter a 10-digit account number and choose a bank.' });
  }
  try {
    return res.status(200).json({
      success: true,
      ...(await wallet.verifyAccount(ids.customerId, accountNumber, bankCode)),
    });
  } catch (e) {
    return sendError(res, e, 'Could not verify the account');
  }
};

export const startWithdrawal = async (req: Request, res: Response) => {
  const ids = await customerIdOf(req, res);
  if (!ids) return;
  const b = req.body ?? {};
  const amount = Number(b.amount);
  const fields = ['accountName', 'accountNumber', 'bankName', 'bankCode'].map(k =>
    String(b[k] ?? '').trim()
  );
  if (!Number.isFinite(amount) || amount < 100 || fields.some(f => !f)) {
    return res
      .status(400)
      .json({ success: false, message: 'Enter an amount of at least ₦100 and your bank details.' });
  }
  try {
    const r = await wallet.startWithdrawal(ids.userId, ids.customerId, {
      amount,
      accountName: fields[0]!,
      accountNumber: fields[1]!,
      bankName: fields[2]!,
      bankCode: fields[3]!,
      ...(b.narration ? { narration: String(b.narration).slice(0, 100) } : {}),
    });
    return res.status(200).json({ success: true, ...r });
  } catch (e) {
    return sendError(res, e, 'Could not start the withdrawal');
  }
};

export const confirmWithdrawal = async (req: Request, res: Response) => {
  const ids = await customerIdOf(req, res);
  if (!ids) return;
  const reference = String(req.body?.reference ?? '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'reference is required' });
  const otp = req.body?.otp ? String(req.body.otp).trim() : undefined;
  try {
    return res
      .status(200)
      .json({ success: true, ...(await wallet.confirmWithdrawal(ids.customerId, reference, otp)) });
  } catch (e) {
    return sendError(res, e, 'Could not complete the withdrawal');
  }
};
