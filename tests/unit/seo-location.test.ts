/** Step 2: what location the public sees. Never the home address. */
import { publicLocation, shortPlace } from '@/seo/location';
import { publicBusiness } from '@/utils/business-public.utils';

const home = {
  businessName: 'Tunde Boots',
  area: 'Ora East',
  address: { street: '12 Secret Close', fullAddress: '12 Secret Close, Ora East, Lagos', city: 'Ikeja', state: 'Lagos', country: 'Nigeria' },
  location: { type: 'Point', coordinates: [3.31, 6.55] },
  followers: ['u1'],
};

describe('publicLocation', () => {
  it('shows area, city and state; no street for a shop with no store', () => {
    expect(publicLocation(home)).toEqual({ area: 'Ora East', city: 'Ikeja', state: 'Lagos', street: null, text: 'Ora East, Ikeja, Lagos' });
  });
  it('needs both switches to show the street', () => {
    expect(publicLocation({ ...home, hasPhysicalStore: true }).street).toBeNull();
    expect(publicLocation({ ...home, showStreetAddress: true }).street).toBeNull();
    expect(publicLocation({ ...home, hasPhysicalStore: true, showStreetAddress: true }).street).toBe('12 Secret Close, Ora East, Lagos');
  });
  it('leaves out missing parts and repeats', () => {
    expect(publicLocation({ address: { city: 'Lagos', state: 'Lagos' } }).text).toBe('Lagos');
    expect(publicLocation({}).text).toBeNull();
    expect(shortPlace(publicLocation(home))).toBe('Ora East, Ikeja');
    expect(shortPlace(publicLocation({ address: { state: 'Imo' } }))).toBe('Imo');
  });
});

describe('publicBusiness (the public shop API)', () => {
  it('a visitor never gets the home address or map position', () => {
    const out = publicBusiness(home, false);
    const json = JSON.stringify(out);
    expect(json).not.toContain('Secret Close');
    expect(json).not.toContain('3.31');
    expect(out.publicLocation).toMatchObject({ text: 'Ora East, Ikeja, Lagos', street: null });
    expect(out.address).toEqual({ city: 'Ikeja', state: 'Lagos', country: 'Nigeria' });
    expect(JSON.stringify(publicBusiness({ ...home, contact: { email: 'me@x.com', phone: '0803' } }, false))).not.toContain('me@x.com');
  });
  it('a shop with a store that shows its address keeps it', () => {
    const out: any = publicBusiness({ ...home, hasPhysicalStore: true, showStreetAddress: true }, false);
    expect(out.publicLocation.street).toBe('12 Secret Close, Ora East, Lagos');
  });
  it('the owner still sees everything', () => {
    expect(JSON.stringify(publicBusiness(home, true))).toContain('Secret Close');
  });
});
