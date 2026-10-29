/**
 * The page-builder: shop and product pages as real HTML (title, description,
 * canonical, Open Graph, JSON-LD and visible text), built on the app's own
 * index.html so people get the same page and React takes over on load.
 *
 *   /<slug>                       shop page (noindex until Google-ready)
 *   /<slug>/p/<id>-<name>         product page (301 if the URL is outdated)
 *   unknown shop or product: 404; deleted product: 410;
 *   hidden product: noindex, no product data; anything else: passed through.
 */
import { Types } from 'mongoose';
import { Business } from '@/models/business-model';
import { Product, VISIBLE_PRODUCT } from '@/models/product-model';
import { DeletedProduct } from '@/models/deleted-product-model';
import { publicBusinessPayload } from '@/services/public-business.service';
import { SEO_CONFIG, siteUrl } from './config';
import { seoCacheGet, seoCacheSet } from './cache';
import { metaDescription, shopDescription } from './describe';
import { esc, INDEX, NOINDEX, renderPage } from './html';
import { appIndexHtml } from './index-html';
import { productJsonLd, shopJsonLd } from './jsonld';
import { publicLocation, shortPlace } from './location';
import { parseSitePath, productPath, slugifyName } from './paths';
import { computeReadiness } from './readiness';
import { naira, productTitle, shopTitle } from './titles';

export interface BuiltPage {
  status: number;
  html?: string;
  /** For 301 redirects. */
  location?: string;
  /** How long the host may cache it. */
  cacheSeconds: number;
}

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A product's own description, unless it only repeats the name (same rule as the app). */
const ownDescription = (description: unknown, name: unknown) => {
  const d = String(description ?? '').trim();
  return d &&
    d.toLowerCase() !==
      String(name ?? '')
        .trim()
        .toLowerCase()
    ? d
    : '';
};

const firstImage = (media?: string[]) =>
  (media ?? []).find(m => /^https?:\/\//.test(m) && !/\.(mp4|mov|webm)(\?|$)/i.test(m)) ?? null;

const wrap = (inner: string) =>
  `<main style="max-width:720px;margin:0 auto;padding:96px 16px 32px;line-height:1.5;color:#111827">${inner}</main>`;

async function messagePage(status: number, title: string, text: string): Promise<BuiltPage> {
  const html = renderPage(await appIndexHtml(), {
    title: `${title} | URA`,
    description: text,
    canonical: null,
    robots: 'noindex, nofollow',
    bodyHtml: wrap(`<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Go to URA</a></p>`),
  });
  return { status, html, cacheSeconds: 300 };
}

const notFound = () =>
  messagePage(404, 'Page not found', 'This page does not exist, or the link is out of date.');

// ─── Shop page ───────────────────────────────────────────────────────────────

async function shopPage(slug: string): Promise<BuiltPage> {
  const payload = await publicBusinessPayload(slug, null);
  if (!payload) return notFound();
  const shop: any = payload.business;
  const visibleProducts = Number(payload.related.counts.products) || 0;
  const products = await Product.find({ business: shop._id, ...VISIBLE_PRODUCT })
    .sort({ createdAt: -1 })
    .limit(SEO_CONFIG.maxProductsOnPage)
    .select('_id name price stock media')
    .lean();

  const url = `${siteUrl()}/${shop.slug}`;
  const loc = publicLocation(shop);
  const description = shopDescription(shop, visibleProducts);
  const { ready } = computeReadiness(shop, visibleProducts);
  const hours = (shop.operatingHours ?? [])
    .filter((h: any) => h?.day)
    .sort((a: any, b: any) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day))
    .map((h: any) =>
      h.isClosed || h.open === 'Closed'
        ? `${esc(h.day)}: closed`
        : `${esc(h.day)}: ${esc(h.open)} to ${esc(h.close)}`
    );

  const body = [
    `<h1>${esc(shop.businessName)}</h1>`,
    shop.category ? `<p>${esc(shop.category)}</p>` : '',
    `<p>${esc(description)}</p>`,
    loc.street
      ? `<p>Address: ${esc(loc.street)}</p>`
      : loc.text
        ? `<p>Area: ${esc(loc.text)}</p>`
        : '',
    Number(shop.totalReviews) > 0
      ? `<p>Rated ${esc(shop.averageRating)} out of 5 from ${esc(shop.totalReviews)} review${shop.totalReviews === 1 ? '' : 's'}</p>`
      : '',
    hours.length
      ? `<h2>Opening hours</h2><ul>${hours.map((h: string) => `<li>${h}</li>`).join('')}</ul>`
      : '',
    products.length
      ? `<h2>Products</h2><ul>${products
          .map(
            p =>
              `<li><a href="${esc(productPath(shop.slug, p))}">${esc(p.name)}</a>${Number(p.price) > 0 ? ` ${esc(naira(p.price))}` : ''}</li>`
          )
          .join('')}</ul>`
      : '',
  ].join('');

  const html = renderPage(await appIndexHtml(), {
    title: shopTitle(shop.businessName, shop.category, shortPlace(loc)),
    description: metaDescription(description),
    canonical: url,
    robots: ready ? INDEX : NOINDEX,
    image: shop.businessCover || shop.businessLogo || null,
    ogType: 'business.business',
    jsonLd: shopJsonLd(shop, { url, description, visibleProducts }),
    bodyHtml: wrap(body),
    pageData: {
      kind: 'shop',
      slug: shop.slug,
      data: { success: true, ...JSON.parse(JSON.stringify(payload)) },
    },
  });
  return { status: 200, html, cacheSeconds: SEO_CONFIG.pageCacheSeconds };
}

// ─── Product page ────────────────────────────────────────────────────────────

const SHOP_FIELDS =
  '_id slug businessName businessLogo isVerified category about area address showOnGoogle hasPhysicalStore showStreetAddress';

async function productPage(slug: string, id: string, nameSlug: string): Promise<BuiltPage> {
  if (!Types.ObjectId.isValid(id)) return notFound();
  const p: any = await Product.findById(id).populate('business', SHOP_FIELDS).lean();
  if (!p) {
    if (await DeletedProduct.exists({ productId: id })) {
      return messagePage(410, 'Product removed', 'This product was removed by the shop.');
    }
    return notFound();
  }
  const shop: any = p.business;
  if (!shop?.slug) return notFound();
  if (p.isHidden) {
    // Switched off by the shop: no product details at all.
    const html = renderPage(await appIndexHtml(), {
      title: 'Product not available | URA',
      description: 'This product is not available right now.',
      canonical: null,
      robots: 'noindex, nofollow',
      bodyHtml: wrap(
        '<h1>Product not available</h1><p>This product is not available right now.</p>'
      ),
    });
    return { status: 200, html, cacheSeconds: 300 };
  }

  const path = productPath(shop.slug, p);
  if (slug !== shop.slug || nameSlug !== slugifyName(p.name)) {
    return {
      status: 301,
      location: `${siteUrl()}${path}`,
      cacheSeconds: SEO_CONFIG.pageCacheSeconds,
    };
  }

  const url = `${siteUrl()}${path}`;
  const shopUrl = `${siteUrl()}/${shop.slug}`;
  const loc = publicLocation(shop);
  const city = loc.city ?? loc.state;
  const visibleProducts = await Product.countDocuments({ business: shop._id, ...VISIBLE_PRODUCT });
  const { ready } = computeReadiness(shop, visibleProducts);
  const own = ownDescription(p.description, p.name);
  const price = Number(p.price) > 0 ? Number(p.price) : null;
  // Only stored facts when the shop wrote no description.
  const description =
    own ||
    [
      `${p.name} from ${shop.businessName}${city ? ` in ${city}` : ''}.`,
      price ? `${naira(price)} on URA.` : '',
    ]
      .filter(Boolean)
      .join(' ');

  const body = wrap(
    [
      `<h1>${esc(p.name)}</h1>`,
      price ? `<p>Price: ${esc(naira(price))}</p>` : '',
      `<p>${Number(p.stock) > 0 ? 'In stock' : 'Out of stock'}</p>`,
      own ? `<p>${esc(own)}</p>` : '',
      `<p>Sold by <a href="/${esc(shop.slug)}">${esc(shop.businessName)}</a>${city ? ` in ${esc(city)}` : ''}</p>`,
    ].join('')
  );

  // The same shape GET /products/:id gives a visitor, with an allowlist of
  // fields (no likes list, no payment codes).
  const productData = {
    _id: p._id,
    name: p.name,
    category: p.category,
    description: p.description,
    price: p.price,
    stock: p.stock,
    size: p.size,
    unit: p.unit,
    media: p.media,
    averageRating: p.averageRating,
    totalReviews: p.totalReviews,
    createdAt: p.createdAt,
    business: {
      _id: shop._id,
      businessName: shop.businessName,
      businessLogo: shop.businessLogo,
      isVerified: shop.isVerified,
      slug: shop.slug,
    },
    isLiked: false,
    isWishlisted: false,
    isOwner: false,
    likesCount: p.likes?.length ?? 0,
    authorId: shop._id,
    displayName: shop.businessName,
    displayAvatar: shop.businessLogo,
  };

  const html = renderPage(await appIndexHtml(), {
    title: productTitle(p.name, price, shop.businessName, city),
    description: metaDescription(description),
    canonical: url,
    robots: ready ? INDEX : NOINDEX,
    image: firstImage(p.media),
    ogType: 'product',
    jsonLd: [productJsonLd(p, { url, shopUrl, shopName: shop.businessName, description })],
    bodyHtml: body,
    pageData: {
      kind: 'product',
      id: String(p._id),
      data: {
        success: true,
        product: JSON.parse(JSON.stringify(productData)),
        relatedProducts: [],
      },
    },
  });
  return { status: 200, html, cacheSeconds: SEO_CONFIG.pageCacheSeconds };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Build the page for a site path. App pages come back untouched. */
export async function buildPage(path: string): Promise<BuiltPage> {
  const parsed = parseSitePath(path);
  if (parsed.kind === 'app') return { status: 200, html: await appIndexHtml(), cacheSeconds: 300 };

  const key =
    parsed.kind === 'shop'
      ? `shop:${parsed.slug}`
      : `product:${parsed.slug}:${parsed.id}:${parsed.nameSlug}`;
  const hit = seoCacheGet<BuiltPage>(key, SEO_CONFIG.pageCacheSeconds);
  if (hit) return hit;

  const page =
    parsed.kind === 'shop'
      ? await shopPage(parsed.slug)
      : await productPage(parsed.slug, parsed.id, parsed.nameSlug);
  // Tag by shop so edits clear it (the shop id is found from the slug).
  const shopId =
    parsed.kind === 'shop'
      ? (await Business.findOne({ slug: parsed.slug }).select('_id').lean())?._id
      : (await Product.findById(parsed.id).select('business').lean())?.business;
  seoCacheSet(key, page, shopId ? [String(shopId)] : []);
  return page;
}
