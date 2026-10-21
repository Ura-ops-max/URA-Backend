/**
 * The Payluk client: retries, the shared rate-limit queue, and no secrets in
 * logs. axios is faked; nothing reaches Payluk.
 */
const SECRET = 'fake-secret-never-log-this';
process.env.PAYLUK_SECRET_KEY = SECRET;
// High limit for most tests; the limit test loads its own copy with 3.
process.env.PAYLUK_RATE_LIMIT_PER_MIN = '1000';

const requestMock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: (...a: unknown[]) => requestMock(...a) }) },
}));

import { paylukRequest, PaylukError, amountToPay, buyerFeeShare, isFunded } from '@/services/payluk.service';

const ok = (data: unknown, headers: Record<string, string> = {}) => ({ status: 200, data: { status: 200, data }, headers });
const httpError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { response: { status, data: { message }, headers } });

let logs: string[] = [];
beforeEach(() => {
  requestMock.mockReset();
  logs = [];
  for (const k of ['log', 'warn', 'error'] as const) {
    jest.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

describe('fee maths (docs: Fees & settlement)', () => {
  it('buyer share of the fee and the total to pay', () => {
    expect(buyerFeeShare({ fee: 200, whoPays: 'buyer' })).toBe(200);
    expect(buyerFeeShare({ fee: 201, whoPays: 'both' })).toBe(100.5);
    expect(buyerFeeShare({ fee: 200, whoPays: 'seller' })).toBe(0);
    expect(amountToPay({ amount: 1_000_000, fee: 25_000, whoPays: 'both', additionalFee: 2_500 })).toBe(1_015_000);
  });
  it('funded = OPENED, or CLOSED after funding', () => {
    expect(isFunded({ state: 'AWAITING_PAYMENT', status: 'PENDING' })).toBe(false);
    expect(isFunded({ state: 'OPENED', status: 'ONGOING' })).toBe(true);
    expect(isFunded({ state: 'CLOSED', status: 'COMPLETED' })).toBe(true);
  });
});

describe('paylukRequest', () => {
  it('unwraps the envelope, sends the secret and customer-id, never logs the secret', async () => {
    requestMock.mockResolvedValueOnce(ok({ mainBalance: 5 }));
    const data = await paylukRequest({ method: 'GET', path: '/v1/wallet', customerId: 'cus_1', idempotent: true });
    expect(data).toEqual({ mainBalance: 5 });
    const cfg = requestMock.mock.calls[0][0];
    expect(cfg.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(cfg.headers['customer-id']).toBe('cus_1');
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('retries a 429 after the reset Payluk gives', async () => {
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too many request', { ratelimit: 'limit=10, remaining=0, reset=1' }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const started = Date.now();
    await expect(paylukRequest({ method: 'POST', path: '/v1/escrow/confirm-payment/e1', customerId: 'b' })).resolves.toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('retries a 5xx only when the call is safe to repeat', async () => {
    requestMock.mockRejectedValueOnce(httpError(502, 'Bad gateway')).mockResolvedValueOnce(ok({ id: 'x' }));
    await expect(paylukRequest({ method: 'GET', path: '/v1/escrow/verify/PY_1', idempotent: true })).resolves.toEqual({ id: 'x' });

    requestMock.mockReset();
    requestMock.mockRejectedValueOnce(httpError(500, 'boom'));
    // Creating an escrow is NOT repeated: a retry could create a second escrow.
    await expect(paylukRequest({ method: 'POST', path: '/v1/escrow/create' })).rejects.toMatchObject({ code: 'SERVER' });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to UNAUTHORIZED and 410 to GONE, without retrying', async () => {
    requestMock.mockRejectedValueOnce(httpError(401, 'Access denied'));
    await expect(paylukRequest({ method: 'GET', path: '/v1/wallet', idempotent: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    requestMock.mockRejectedValueOnce(httpError(410, 'Gone'));
    await expect(paylukRequest({ method: 'POST', path: '/v1/payment/virtual-account' })).rejects.toBeInstanceOf(PaylukError);
  });

  it('never goes over the per-minute limit: extra calls wait, then answer "busy"', async () => {
    // A fresh copy of the client with its own queue, limited to 3 a minute.
    process.env.PAYLUK_RATE_LIMIT_PER_MIN = '3';
    let limited!: typeof import('@/services/payluk.service');
    jest.isolateModules(() => {
      limited = require('@/services/payluk.service');
    });
    process.env.PAYLUK_RATE_LIMIT_PER_MIN = '1000';

    requestMock.mockResolvedValue(ok({}));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => limited.paylukRequest({ method: 'GET', path: '/v1/wallet', maxQueueMs: 200 }))
    );
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(r => r.status === 'rejected' && (r.reason as any).code === 'BUSY')).toHaveLength(3);
  });
});
