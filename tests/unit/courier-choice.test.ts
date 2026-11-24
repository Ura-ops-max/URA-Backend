/** Courier choice and fallback; status normalisation; webhook parsing. */
const chowdeckQuote = jest.fn();
const fezCost = jest.fn();
jest.mock('@/services/chowdeck.service', () => {
  const actual = jest.requireActual('@/services/chowdeck.service');
  return { ...actual, getChowdeckQuote: (...a: any[]) => chowdeckQuote(...a) };
});
jest.mock('@/services/fez.service', () => {
  const actual = jest.requireActual('@/services/fez.service');
  return { ...actual, isFezConfigured: () => true, getDeliveryCost: (...a: any[]) => fezCost(...a) };
});

import {
  chooseCourier,
  normaliseChowdeckStatus,
  normaliseFezStatus,
  normalisePlace,
  parseChowdeckEvent,
  quoteDelivery,
  sharedServiceArea,
} from '@/services/courier.service';

const ENV = { ...process.env };
const lagosShop = { address: { fullAddress: '31 Allen Ave', city: 'Ikeja', state: 'Lagos' }, location: { coordinates: [3.35, 6.6] } };

beforeEach(() => {
  process.env.CHOWDECK_API_KEY = 'k';
  process.env.CHOWDECK_CITIES = 'Lagos, Abuja, Port Harcourt';
  chowdeckQuote.mockReset();
  fezCost.mockReset().mockResolvedValue({ cost: 3000, vat: 225, totalCost: 3225, state: 'Oyo', raw: { status: 'Success' } });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

describe('which courier', () => {
  it('same service area on the list: Chowdeck', () => {
    expect(chooseCourier({ city: 'Ikeja', state: 'Lagos' }, { city: 'Lekki', state: 'Lagos State' })).toBe('chowdeck');
    expect(chooseCourier({ state: 'FCT' }, { city: 'Abuja' })).toBe('chowdeck');
    expect(sharedServiceArea({ city: 'Port-Harcourt' }, { state: 'Rivers', city: 'port harcourt' })).toBe('port harcourt');
  });
  it('interstate, or a place not on the list: Fez', () => {
    expect(chooseCourier({ city: 'Ikeja', state: 'Lagos' }, { city: 'Ibadan', state: 'Oyo' })).toBe('fez');
    expect(chooseCourier({ state: 'Kano' }, { state: 'Kano' })).toBe('fez');
  });
  it('no Chowdeck settings: always Fez (today)', () => {
    delete process.env.CHOWDECK_API_KEY;
    expect(chooseCourier({ state: 'Lagos' }, { state: 'Lagos' })).toBe('fez');
    process.env.CHOWDECK_API_KEY = 'k';
    process.env.CHOWDECK_CITIES = '';
    expect(chooseCourier({ state: 'Lagos' }, { state: 'Lagos' })).toBe('fez');
  });
  it('place names are normalised', () => {
    expect(normalisePlace(' Lagos State ')).toBe('lagos');
    expect(normalisePlace('Federal Capital Territory')).toBe('abuja');
  });
});

describe('quote with fallback', () => {
  const dropoff = { state: 'Lagos', city: 'Lekki', fullAddress: '1 Admiralty Way', latitude: 6.44, longitude: 3.47 };

  it('same city: Chowdeck price, shop coordinates and buyer location', async () => {
    chowdeckQuote.mockResolvedValue({ feeId: 7, totalNaira: 2100 });
    const q = await quoteDelivery({ shop: lagosShop, dropoff, orderValueNaira: 15000 });
    expect(q).toEqual({ provider: 'chowdeck', totalCost: 2100, eta: 'Same day' });
    expect(chowdeckQuote).toHaveBeenCalledWith({
      pickup: { address: '31 Allen Ave, Ikeja, Lagos', lat: 6.6, lng: 3.35 },
      dropoff: { address: '1 Admiralty Way, Lekki, Lagos', lat: 6.44, lng: 3.47 },
      orderValueNaira: 15000,
    });
    expect(fezCost).not.toHaveBeenCalled();
  });
  it('interstate: Fez, exactly as today', async () => {
    const q = await quoteDelivery({ shop: lagosShop, dropoff: { state: 'Oyo', city: 'Ibadan' } });
    expect(q).toMatchObject({ provider: 'fez', totalCost: 3225 });
    expect(fezCost).toHaveBeenCalledWith({ state: 'Oyo', pickUpState: 'Lagos' });
    expect(chowdeckQuote).not.toHaveBeenCalled();
  });
  it('Chowdeck quote fails: falls back to Fez', async () => {
    chowdeckQuote.mockRejectedValue(new Error('Outside delivery zone'));
    const q = await quoteDelivery({ shop: lagosShop, dropoff });
    expect(q).toMatchObject({ provider: 'fez', totalCost: 3225 });
    expect(fezCost).toHaveBeenCalledWith({ state: 'Lagos', pickUpState: 'Lagos' });
  });
  it('no shop address to collect from: Fez', async () => {
    const q = await quoteDelivery({ shop: null, pickUpState: 'Lagos', dropoff });
    expect(q.provider).toBe('fez');
    expect(chowdeckQuote).not.toHaveBeenCalled();
  });
});

describe('statuses', () => {
  it('Chowdeck values', () => {
    expect(normaliseChowdeckStatus('preparing')).toBe('booked');
    expect(normaliseChowdeckStatus('picked')).toBe('in_transit');
    expect(normaliseChowdeckStatus('success')).toBe('delivered');
    expect(normaliseChowdeckStatus('completed')).toBe('delivered');
    expect(normaliseChowdeckStatus('rejected')).toBe('cancelled');
    expect(normaliseChowdeckStatus('nonsense')).toBeNull();
  });
  it('Fez words', () => {
    expect(normaliseFezStatus('Pending Pick-Up')).toBe('awaiting_pickup');
    expect(normaliseFezStatus('Dispatched')).toBe('in_transit');
    expect(normaliseFezStatus('Delivered')).toBe('delivered');
    expect(normaliseFezStatus('Returned')).toBe('failed');
  });
  it('webhook bodies: status field or event name', () => {
    expect(parseChowdeckEvent({ category: 'ORDER_PICKED_UP', payload: { reference: 'ORD-1' } })).toEqual({ reference: 'ORD-1', status: 'in_transit' });
    expect(parseChowdeckEvent({ data: { reference: 'ORD-2', status: 'success' } })).toEqual({ reference: 'ORD-2', status: 'delivered' });
  });
});
