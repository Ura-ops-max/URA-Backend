/**
 * Google visibility settings, in one place.
 *
 * PUBLIC_SITE_URL: the address shop pages live at. The live site today
 * redirects ura.com.ng to www.ura.com.ng, so the default is www. If the
 * redirect is flipped to the bare domain, set PUBLIC_SITE_URL to match (see
 * docs/google-routing.md). Canonical URLs, the sitemap and robots.txt use it.
 */
export const SEO_CONFIG = {
  /** A shop is Ready when visible, showOnGoogle, named, AND (About >= 50 chars OR >= 1 visible product). */
  ready: { minAboutChars: 50, minVisibleProducts: 1 },
  metaDescriptionChars: 155,
  maxProductsOnPage: 20,
  pageCacheSeconds: 60 * 60,
  sitemapCacheSeconds: 60 * 60,
  /** Google's limit is 50,000 URLs per sitemap file. */
  sitemapUrlsPerFile: 45_000,
  readinessJobMinutes: 60,
} as const;

export const siteUrl = (): string =>
  String(process.env.PUBLIC_SITE_URL || 'https://www.ura.com.ng').replace(/\/+$/, '');

/** Where the built app's index.html is fetched from (the S3/CloudFront origin). */
export const frontendIndexUrl = (): string =>
  String(process.env.FRONTEND_INDEX_URL || `${siteUrl()}/index.html`);
