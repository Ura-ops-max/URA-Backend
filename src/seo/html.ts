/** Adds a page's own head tags and visible content to the app's index.html. */
import { ldScript, type JsonLd } from './jsonld';

export const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

export const INDEX = 'index, follow, max-image-preview:large';
export const NOINDEX = 'noindex, follow';

export interface PageParts {
  title: string;
  description: string;
  canonical: string | null;
  robots: string;
  image?: string | null;
  ogType?: string;
  jsonLd?: JsonLd[];
  /** Visible content, placed inside the app's root element. */
  bodyHtml: string;
  /** Same data the app would fetch, so it shows the page at once. */
  pageData?: unknown;
}

// The home page's own SEO tags in index.html, replaced on built pages.
const STRIP = [
  /<title>[\s\S]*?<\/title>/i,
  /<meta\s+name="(?:description|keywords|robots|google-site-verification)"[\s\S]*?\/?>/gi,
  /<meta\s+property="og:[^"]*"[\s\S]*?\/?>/gi,
  /<meta\s+name="twitter:[^"]*"[\s\S]*?\/?>/gi,
  /<link\s+rel="canonical"[\s\S]*?\/?>/gi,
];

export function renderPage(indexHtml: string, p: PageParts): string {
  let html = indexHtml;
  for (const re of STRIP) html = html.replace(re, '');

  const head: string[] = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<meta name="robots" content="${p.robots}" />`,
  ];
  if (p.canonical) head.push(`<link rel="canonical" href="${esc(p.canonical)}" />`);
  head.push(
    `<meta property="og:site_name" content="URA" />`,
    `<meta property="og:locale" content="en_NG" />`,
    `<meta property="og:type" content="${esc(p.ogType ?? 'website')}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`
  );
  if (p.canonical) head.push(`<meta property="og:url" content="${esc(p.canonical)}" />`);
  if (p.image) head.push(`<meta property="og:image" content="${esc(p.image)}" />`);
  head.push(
    `<meta name="twitter:card" content="${p.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(p.title)}" />`,
    `<meta name="twitter:description" content="${esc(p.description)}" />`
  );
  if (p.image) head.push(`<meta name="twitter:image" content="${esc(p.image)}" />`);
  const verify = process.env.GOOGLE_SITE_VERIFICATION;
  if (verify) head.push(`<meta name="google-site-verification" content="${esc(verify)}" />`);
  if (p.jsonLd?.length) head.push(ldScript(p.jsonLd.length === 1 ? p.jsonLd[0] : p.jsonLd));
  if (p.pageData !== undefined) {
    head.push(
      `<script id="ura-page-data" type="application/json">${JSON.stringify(p.pageData).replace(/</g, '\\u003c')}</script>`
    );
  }

  html = html.replace('</head>', `${head.join('\n')}\n</head>`);
  html = html.replace(/<div id="root">\s*<\/div>/, `<div id="root">${p.bodyHtml}</div>`);
  return html;
}
