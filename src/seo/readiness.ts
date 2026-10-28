/**
 * Is a shop ready to be found on Google? Worked out from stored data only, so
 * it updates by itself when the shop or its products change. Nothing to set.
 *
 * Ready = visible AND showOnGoogle AND has a name AND
 *         (About of at least 50 characters OR at least 1 visible product).
 * Address, city and state are NOT required.
 */
import { SEO_CONFIG } from './config';

export type NotReadyReason = 'google-off' | 'no-name' | 'no-about-or-products';

export interface ReadinessInput {
  businessName?: string | null;
  about?: string | null;
  showOnGoogle?: boolean | null;
  area?: string | null;
  /** URA has no way to hide a whole shop yet, so every shop is visible. */
  hidden?: boolean;
}

export interface Readiness {
  ready: boolean;
  reasons: NotReadyReason[];
  /** Plain next steps for the owner's "Google ready" bar. */
  nextSteps: string[];
}

const aboutLength = (about?: string | null) => String(about ?? '').trim().length;

export function computeReadiness(shop: ReadinessInput, visibleProducts: number): Readiness {
  const { minAboutChars, minVisibleProducts } = SEO_CONFIG.ready;
  const reasons: NotReadyReason[] = [];
  if (shop.hidden || shop.showOnGoogle === false) reasons.push('google-off');
  if (!String(shop.businessName ?? '').trim()) reasons.push('no-name');
  const hasAbout = aboutLength(shop.about) >= minAboutChars;
  const hasProducts = visibleProducts >= minVisibleProducts;
  if (!hasAbout && !hasProducts) reasons.push('no-about-or-products');

  const nextSteps: string[] = [];
  if (reasons.includes('google-off'))
    nextSteps.push('Turn on "Show my shop on Google" in shop settings');
  if (reasons.includes('no-name')) nextSteps.push('Add your shop name');
  if (!hasAbout) nextSteps.push(`Add an About (at least ${minAboutChars} characters)`);
  if (!hasProducts) nextSteps.push('Add a product');
  if (!String(shop.area ?? '').trim()) nextSteps.push('Add your area');

  return { ready: reasons.length === 0, reasons, nextSteps };
}

export const REASON_TEXT: Record<NotReadyReason, string> = {
  'google-off': 'Turned off "Show my shop on Google"',
  'no-name': 'No shop name',
  'no-about-or-products': 'No About and no products',
};
