import { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { asyncHandler } from '@/middleware/errorHandler';

/**
 * AI assistant (Ura chatbot) — proxies chat to Claude server-side so the API
 * key never reaches the browser. Falls back gracefully (503) when the key isn't
 * configured, so the frontend can use its built-in rule-based answers.
 */

const SYSTEM_PROMPT = `You are the Ura assistant, a friendly and concise support agent for URA — a Nigerian social-commerce marketplace where people discover businesses, buy and sell products, and pay securely with escrow (via the payment partner Payluk).

Answer questions about: creating an account and email verification, signing in and password reset, payments (instant or escrow), funding the wallet (a one-time virtual bank account is generated under "Fund Wallet"), becoming a seller (Settings → Convert to Business), disputes/refunds (Wallet → Respond to Dispute), delivery, and privacy/security (data is encrypted and never sold).

Guidelines:
- Keep replies short, warm, and helpful — usually 1–3 sentences.
- Only answer about URA and how to use it. If asked something unrelated or that you don't know, say so briefly and suggest the Contact page or emailing info@ura.com.ng.
- Never invent policies, prices, or features. Don't ask for passwords, card numbers, or OTPs.
- If the user wants a human, tell them to use the Contact page or email info@ura.com.ng.`;

type IncomingMessage = { role: 'user' | 'assistant'; content: string };

let client: Anthropic | null = null;
const getClient = (): Anthropic =>
  (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

export const assistantChat = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ success: false, message: 'AI assistant is not configured.' });
    return;
  }

  const incoming = Array.isArray(req.body?.messages) ? (req.body.messages as IncomingMessage[]) : [];

  // Sanitize: keep only valid user/assistant text turns, cap history length.
  const messages = incoming
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }));

  // The Messages API requires the conversation to start with a user turn.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length === 0) {
    res.status(400).json({ success: false, message: 'No message provided.' });
    return;
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    res.status(200).json({ success: true, reply: reply || "Sorry, I didn't catch that — could you rephrase?" });
  } catch (error) {
    console.error('[assistantChat] Claude request failed:', (error as Error).message);
    res.status(502).json({ success: false, message: 'The assistant is temporarily unavailable.' });
  }
});
