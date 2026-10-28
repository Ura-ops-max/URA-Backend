/** Step 5: structured data from stored facts only. */
import { ldScript, openingHours, productJsonLd, shopJsonLd, shopKind } from '@/seo/jsonld';

const shop = {
  businessName: 'Tunde Boots',
  category: 'Shoes',
  businessLogo: 'https://cdn/logo.png',
  area: 'Ora East',
  address: { street: '12 Secret Close', fullAddress: '12 Secret Close', city: 'Ikeja', state: 'Lagos' },
  contact: { phone: '08031234567' },
  operatingHours: [
    { day: 'Monday', open: '09:00', close: '17:00' },
    { day: 'Sunday', open: 'Closed', close: 'Closed' },
  ],
  averageRating: 4.5,
  totalReviews: 8,
};
const opts = { url: 'https://www.ura.com.ng/tunde-boots', description: 'Boots.', visibleProducts: 3 };

describe('shop JSON-LD', () => {
  it('a product seller is a Store with real facts', () => {
    const [ld] = shopJsonLd(shop, opts) as any[];
    expect(ld).toMatchObject({
      '@type': 'Store',
      name: 'Tunde Boots',
      url: opts.url,
      image: 'https://cdn/logo.png',
      areaServed: 'Ora East, Ikeja, Lagos',
      address: { '@type': 'PostalAddress', addressLocality: 'Ikeja', addressRegion: 'Lagos', addressCountry: 'NG' },
      telephone: '08031234567',
      openingHours: ['Mo 09:00-17:00'],
      aggregateRating: { ratingValue: 4.5, reviewCount: 8 },
    });
    expect(JSON.stringify(ld)).not.toContain('Secret');
  });
  it('the street only by the display rule', () => {
    const [ld] = shopJsonLd({ ...shop, hasPhysicalStore: true, showStreetAddress: true }, opts) as any[];
    expect(ld.address.streetAddress).toBe('12 Secret Close');
  });
  it('leaves out missing fields; no rating without reviews', () => {
    const [ld] = shopJsonLd({ businessName: 'Plain' }, { ...opts, visibleProducts: 0 }) as any[];
    expect(Object.keys(ld).sort()).toEqual(['@context', '@id', '@type', 'description', 'name', 'url']);
    const [noReviews] = shopJsonLd({ ...shop, totalReviews: 0 }, opts) as any[];
    expect(noReviews.aggregateRating).toBeUndefined();
  });
  it('a service vendor gets a Service with provider and areaServed', () => {
    expect(shopKind('Hair Salon', 0)).toBe('Service');
    const lds = shopJsonLd({ ...shop, category: 'Hair Salon' }, { ...opts, visibleProducts: 0 }) as any[];
    expect(lds[1]).toMatchObject({ '@type': 'Service', provider: { '@id': `${opts.url}#shop` }, areaServed: 'Ora East, Ikeja, Lagos' });
  });
  it('opening hours skip closed days and odd values', () => {
    expect(openingHours([{ day: 'Friday', open: '8:00', close: '20:30' }, { day: 'Tuesday', open: '?', close: '17:00' }])).toEqual(['Fr 8:00-20:30']);
  });
});

describe('product JSON-LD', () => {
  const p = { name: 'Chelsea Boot', media: ['https://cdn/1.jpg', 'https://cdn/v.mp4'], price: 25000, stock: 0 };
  const po = { url: 'https://www.ura.com.ng/tunde-boots/p/abc-chelsea-boot', shopUrl: opts.url, shopName: 'Tunde Boots', description: 'Leather.' };
  it('has the offer in NGN, availability and the shop as seller', () => {
    expect(productJsonLd(p, po)).toMatchObject({
      '@type': 'Product',
      image: ['https://cdn/1.jpg'],
      offers: { price: 25000, priceCurrency: 'NGN', availability: 'https://schema.org/OutOfStock', seller: { name: 'Tunde Boots' } },
    });
  });
  it('no price: no offer (never invented)', () => {
    expect(productJsonLd({ name: 'Free' }, po).offers).toBeUndefined();
  });
  it('script is safe against </script>', () => {
    expect(ldScript({ name: '</script><script>alert(1)' })).not.toContain('</script><script>');
  });
});
