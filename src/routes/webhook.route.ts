/**
 * Payluk webhook: POST /api/v1/webhooks/payluk
 *
 * Docs (Webhooks): Payluk signs the RAW JSON body with HMAC-SHA512, keyed with
 * the environment's SECRET KEY, hex, in `x-payluk-signature`. It waits up to
 * 10 seconds, retries up to 3 times, and may send events more than once and
 * out of order.
 *
 * So this route only: checks the signature, records the event once
 * (de-duplicated), queues the work, and answers 200 at once. The work itself
 * runs in the background worker (services/payluk-jobs.service.ts), which
 * treats data.status / data.state as the truth.
 */
import express from 'express';
import crypto from 'crypto';
import { PaylukWebhookEvent } from '@/models/payluk-webhook-event-model';
import { PaylukJob } from '@/models/payluk-job-model';
import { applyChowdeckEvent, verifyChowdeckSignature } from '@/services/chowdeck-webhook.service';
import { parseChowdeckEvent } from '@/services/courier.service';

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Constant-time check of x-payluk-signature against the raw body. */
export function verifyPaylukSignature(
  rawBody: Buffer | undefined,
  signature: string,
  secret: string
): boolean {
  if (!rawBody || !secret || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/** De-duplication key (docs: Be idempotent). */
export function webhookKey(event: string, data: Record<string, any>): string | null {
  if (event.startsWith('escrow.')) return data?.id ? `escrow:${data.id}:${event}` : null;
  if (event.startsWith('payment.'))
    return data?.reference ? `payment:${data.reference}:${event}` : null;
  return null;
}

/** Events URA acts on; anything else is acknowledged and ignored. */
const HANDLED = /^(escrow\.[a-z]+|payment\.(escrow|delivery|commission)\.success)$/;

router.post('/payluk', async (req, res) => {
  const secret = process.env.PAYLUK_SECRET_KEY || '';
  if (!secret) {
    console.error('[webhook] PAYLUK_SECRET_KEY is not set; cannot verify Payluk webhooks');
    return res.status(500).json({ ok: false });
  }

  const signature = String(req.headers['x-payluk-signature'] || '');
  if (!verifyPaylukSignature((req as any).rawBody, signature, secret)) {
    console.warn('[webhook] rejected: missing or invalid x-payluk-signature');
    return res.status(401).json({ ok: false, message: 'Invalid signature' });
  }

  const event = String(req.body?.event || '');
  const data = (req.body?.data || {}) as Record<string, any>;
  const key = webhookKey(event, data);

  // Trace line for every event, without secrets.
  console.log(
    `[webhook] ${event} escrow=${data.id ?? data.escrowDetails?.escrowId ?? '-'} ref=${data.reference ?? '-'} status=${data.status ?? '-'} state=${data.state ?? '-'} env=${data.environment ?? '-'}`
  );

  if (!key || !HANDLED.test(event)) return res.status(200).json({ ok: true, ignored: true });

  try {
    await PaylukWebhookEvent.create({
      key,
      event,
      escrowId: data.id ?? data.escrowDetails?.escrowId,
      reference: data.reference,
      status: data.status,
      state: data.state,
      environment: data.environment,
    });
  } catch (e: any) {
    if (e?.code === 11000) return res.status(200).json({ ok: true, duplicate: true });
    console.error('[webhook] could not record event:', e?.message);
    return res.status(500).json({ ok: false }); // Payluk will retry
  }

  try {
    const now = new Date();
    await PaylukJob.create({
      key: `webhook:${key}`,
      type: 'webhook',
      status: 'pending',
      payload: { event, data },
      runAt: now,
      expiresAt: new Date(now.getTime() + DAY_MS),
    });
  } catch (e: any) {
    if (e?.code !== 11000) console.error('[webhook] could not queue event:', e?.message);
  }

  return res.status(200).json({ ok: true });
});

/**
 * Chowdeck Relay delivery events: POST /api/v1/webhooks/chowdeck
 * Signed with HMAC-SHA256 of the RAW body (hex) in `x-chowdeck-signature`,
 * keyed with CHOWDECK_WEBHOOK_SECRET. Applied once per status; answers 200
 * fast, including for events we don't act on.
 * TODO(chowdeck-q5): Relay delivery webhooks are not documented yet (only
 * food-order events are). If Relay sends none, poll getChowdeckDelivery.
 */
router.post('/chowdeck', async (req, res) => {
  const secret = process.env.CHOWDECK_WEBHOOK_SECRET || '';
  if (!secret) {
    console.error('[webhook] CHOWDECK_WEBHOOK_SECRET is not set; cannot verify Chowdeck webhooks');
    return res.status(500).json({ ok: false });
  }
  const signature = String(req.headers['x-chowdeck-signature'] || '');
  if (!verifyChowdeckSignature((req as any).rawBody, signature, secret)) {
    console.warn('[webhook] rejected: missing or invalid x-chowdeck-signature');
    return res.status(401).json({ ok: false, message: 'Invalid signature' });
  }

  try {
    const event = parseChowdeckEvent(req.body);
    const result = await applyChowdeckEvent(event);
    console.log(
      `[webhook] chowdeck ref=${event.reference ?? '-'} status=${event.status ?? '-'} → ${result}`
    );
  } catch (e: any) {
    // Still 200: a retry would hit the same problem; the error is logged.
    console.error('[webhook] chowdeck event failed:', e?.message);
  }
  return res.status(200).json({ ok: true });
});

export default router;
