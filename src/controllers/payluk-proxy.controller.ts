import { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import { asyncHandler } from '@/middleware/errorHandler';

/**
 * Payluk proxy
 * ------------
 * Payluk's API does not allow browser-direct calls (its CORS preflight rejects
 * the custom `customer-id` / `Authorization` headers), and the secret key must
 * never ship in the frontend bundle. So the browser calls our backend at
 * `/api/v1/payluk/*` and we forward the request to Payluk server-side, adding
 * the secret here.
 *
 * Security:
 *  - The `customer-id` is taken from the signed-in URA user, NEVER from the
 *    browser, so a user can't act on another customer's wallet/escrow.
 *  - Only the exact paths the app uses are forwarded (allowlist); anything else
 *    is refused, so the secret key can't be used against arbitrary endpoints.
 */

const API_BASE = (process.env.PAYLUK_API_BASE || 'https://staging.api.payluk.ng').replace(
  /\/$/,
  ''
);
const SECRET = process.env.PAYLUK_SECRET_KEY || '';

// Payluk's REST paths are versioned under /v1.
const paylukProxyAxios = axios.create({
  baseURL: `${API_BASE}/v1`,
  timeout: 20_000,
});

// The only Payluk paths the URA app ever calls. Everything else is refused.
const ALLOWED_PATHS: RegExp[] = [
  /^\/wallet\/?$/,
  /^\/payment\/(virtual-account|bank-list|verify-account|create-intent|verify|history|escrow)\/?$/,
  /^\/escrow\/transactions\/?$/,
  /^\/escrow\/(claim-funds|confirm-payment|submit-dispute)\/[^/]+\/?$/,
];

const isAllowed = (path: string): boolean => ALLOWED_PATHS.some(re => re.test(path));

export const paylukProxy = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // When mounted with router.use('/payluk', ...), req.path is the remainder,
  // e.g. "/payment/virtual-account".
  const targetPath = req.path;

  if (!isAllowed(targetPath)) {
    res.status(403).json({ success: false, message: 'This Payluk operation is not allowed.' });
    return;
  }

  // Always use the signed-in user's own Payluk customer id — never a value the
  // browser supplied. requireAuth has already attached the user.
  const customerId: string | undefined = (req as any).user?.paylukCustomerId;

  // File uploads (e.g. dispute evidence) arrive as multipart/form-data. Our JSON
  // body parser leaves that body untouched, so we stream the raw request through
  // and keep its original Content-Type (with the multipart boundary) intact —
  // otherwise the fields (like the dispute `message`) never reach Payluk.
  const reqContentType = req.headers['content-type'] || '';
  const isMultipart = reqContentType.startsWith('multipart/');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${SECRET}`,
    accept: 'application/json',
    'Content-Type': isMultipart ? reqContentType : 'application/json',
  };
  if (customerId) headers['customer-id'] = customerId;

  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase());

  try {
    const response = await paylukProxyAxios.request({
      method: req.method as never,
      url: targetPath,
      params: req.query,
      data: hasBody ? (isMultipart ? req : req.body) : undefined,
      headers,
      ...(isMultipart ? { maxBodyLength: Infinity, maxContentLength: Infinity } : {}),
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status ?? 502;
    console.error(
      `❌ [PaylukProxy] ${req.method} ${targetPath} → ${status}`,
      axiosErr.response?.data
    );
    // Payluk doesn't always use `message`; surface whatever reason it gave so
    // the app can show it instead of a generic error.
    const data: any = axiosErr.response?.data;
    const reason =
      (typeof data === 'string' && data) ||
      data?.message ||
      data?.error?.message ||
      data?.error ||
      data?.msg ||
      (axiosErr.response ? `Payluk returned ${status}` : 'Could not reach Payluk');
    res.status(status).json({
      ...(data && typeof data === 'object' ? data : {}),
      success: false,
      message: String(reason),
    });
  }
});
