/**
 * The built app's index.html (with its script and style tags), fetched from
 * the frontend host and kept 5 minutes. Built pages are this file with the
 * page's own head tags and content added, so React loads as normal on top.
 */
import { frontendIndexUrl } from './config';

const FALLBACK =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>URA</title></head><body><div id="root"></div></body></html>';

let cached: { at: number; html: string } | null = null;
let override: string | null = null;

/** For tests: use this HTML instead of fetching. */
export function setIndexHtmlForTests(html: string | null): void {
  override = html;
}

export async function appIndexHtml(): Promise<string> {
  if (override) return override;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.html;
  try {
    const res = await globalThis.fetch(frontendIndexUrl(), {
      headers: { 'User-Agent': 'URA-page-builder' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('id="root"')) throw new Error('no app root element');
    cached = { at: Date.now(), html };
    return html;
  } catch (e) {
    console.error('[seo] could not load the app index.html:', (e as Error).message);
    return cached?.html ?? FALLBACK;
  }
}
