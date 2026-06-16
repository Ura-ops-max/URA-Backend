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
 */

const API_BASE = (process.env.PAYLUK_API_BASE || 'https://staging.api.payluk.ng').replace(/\/$/, '');
const SECRET = process.env.PAYLUK_SECRET_KEY || '';

// Payluk's REST paths are versioned under /v1.
const paylukProxyAxios = axios.create({
  baseURL: `${API_BASE}/v1`,
  timeout: 20_000,
});

export const paylukProxy = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // When mounted with router.use('/payluk', ...), req.path is the remainder,
  // e.g. "/payment/virtual-account".
  const targetPath = req.path;
  const customerId = req.header('customer-id');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${SECRET}`,
    accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (customerId) headers['customer-id'] = customerId;

  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase());

  try {
    const response = await paylukProxyAxios.request({
      method: req.method as never,
      url: targetPath,
      params: req.query,
      data: hasBody ? req.body : undefined,
      headers,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status ?? 502;
    console.error(`❌ [PaylukProxy] ${req.method} ${targetPath} → ${status}`, axiosErr.response?.data);
    res
      .status(status)
      .json(axiosErr.response?.data ?? { success: false, message: 'Payluk request failed' });
  }
});
