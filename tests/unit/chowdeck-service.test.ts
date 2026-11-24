/** Chowdeck service: kobo/naira, phones, request shapes, errors. HTTP is faked. */
import {
  cancelChowdeckDelivery,
  ChowdeckError,
  chowdeckBaseUrl,
  chowdeckHttp,
  createChowdeckDelivery,
  getChowdeckQuote,
  isChowdeckConfigured,
  koboToNaira,
  nairaToKobo,
  toLocalPhone,
} from '@/services/chowdeck.service';

const ENV = { ...process.env };
let calls: any[] = [];
const reply = (data: unknown) =>
  jest.spyOn(chowdeckHttp, 'request').mockImplementation(async (cfg: any) => {
    calls.push(cfg);
    return { data } as any;
  });

beforeEach(() => {
  calls = [];
  process.env.CHOWDECK_API_KEY = 'test-key';
  delete process.env.CHOWDECK_BASE_URL;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

describe('money and phones', () => {
  it('kobo to naira and back', () => {
    expect(koboToNaira(80000)).toBe(800);
    expect(koboToNaira(210000)).toBe(2100);
    expect(koboToNaira(12345)).toBe(123); // rounded to whole naira
    expect(koboToNaira(undefined)).toBe(0);
    expect(nairaToKobo(800)).toBe(80000);
    expect(nairaToKobo('2100')).toBe(210000);
  });
  it('phones become 11-digit local numbers', () => {
    expect(toLocalPhone('+2348012345678')).toBe('08012345678');
    expect(toLocalPhone('2348012345678')).toBe('08012345678');
    expect(toLocalPhone('0801 234 5678')).toBe('08012345678');
    expect(toLocalPhone('8012345678')).toBe('08012345678');
  });
});

describe('settings', () => {
  it('needs an API key; the host comes from CHOWDECK_BASE_URL', () => {
    expect(isChowdeckConfigured()).toBe(true);
    delete process.env.CHOWDECK_API_KEY;
    expect(isChowdeckConfigured()).toBe(false);
    expect(chowdeckBaseUrl()).toBe('https://api.relay.chowdeck.com');
    process.env.CHOWDECK_BASE_URL = 'https://api.chowdeck.com/';
    expect(chowdeckBaseUrl()).toBe('https://api.chowdeck.com');
  });
  it('does not call Chowdeck without a key', async () => {
    delete process.env.CHOWDECK_API_KEY;
    const spy = reply({});
    await expect(getChowdeckQuote({ pickup: { address: 'a' }, dropoff: { address: 'b' } })).rejects.toMatchObject({ statusCode: 503 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('quote', () => {
  it('sends coordinates when known, address text otherwise, and returns naira', async () => {
    reply({ status: 'success', data: { id: 18987, total_amount: 210000 } });
    const q = await getChowdeckQuote({
      pickup: { address: 'Shop, Ikeja, Lagos', lat: 6.6, lng: 3.35 },
      dropoff: { address: '12 Adeola Odeku St, Lagos' },
      orderValueNaira: 15000,
    });
    expect(q).toMatchObject({ feeId: 18987, totalNaira: 2100 });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/relay/delivery/fee',
      baseURL: 'https://api.relay.chowdeck.com',
      headers: { Authorization: 'Bearer test-key' },
      data: {
        source_address: { latitude: 6.6, longitude: 3.35 },
        destination_address_string: '12 Adeola Odeku St, Lagos',
        estimated_order_amount: 1500000,
      },
    });
  });
  it('a "failed" reply or no price is an error', async () => {
    reply({ status: 'failed', message: '"source_address" is required' });
    await expect(getChowdeckQuote({ pickup: { address: '' }, dropoff: { address: 'b' } })).rejects.toThrow('"source_address" is required');
  });
});

describe('create and cancel', () => {
  it('builds the create body (kobo, local phones, NG) and returns naira', async () => {
    reply({ status: 'success', data: { id: 3122, reference: 'ORD-1', delivery_price: 210000, status: 'preparing', tracking_url: 'https://track.chowdeck.com/x' } });
    const d = await createChowdeckDelivery({
      feeId: 18987,
      reference: 'ORD-1',
      itemType: 'Shoes',
      orderValueNaira: 15000,
      sender: { name: 'Tunde Boots', phone: '+2348011111111' },
      recipient: { name: 'Amaka O', phone: '08022222222', email: 'a@example.com' },
      note: 'Deliver to: 12 Adeola Odeku St',
      deliveryPin: 4821,
    });
    expect(d).toEqual({ id: 3122, reference: 'ORD-1', trackingUrl: 'https://track.chowdeck.com/x', status: 'preparing', priceNaira: 2100 });
    expect(calls[0].data).toEqual({
      fee_id: 18987,
      reference: 'ORD-1',
      item_type: 'Shoes',
      user_action: 'sending',
      source_contact: { name: 'Tunde Boots', phone: '08011111111', country_code: 'NG' },
      destination_contact: { name: 'Amaka O', phone: '08022222222', country_code: 'NG', email: 'a@example.com' },
      estimated_order_amount: 1500000,
      customer_delivery_note: 'Deliver to: 12 Adeola Odeku St',
      delivery_pin: 4821,
      notification_channels: ['sms'],
    });
  });
  it('a duplicate reference is recognised', async () => {
    jest.spyOn(chowdeckHttp, 'request').mockRejectedValue({
      response: { status: 400, data: 'Possible duplicate order. Please send unique reference' },
      message: 'Request failed',
    });
    const err = await createChowdeckDelivery({
      feeId: 1, reference: 'ORD-1', itemType: 'x',
      sender: { name: 's', phone: '08011111111' }, recipient: { name: 'r', phone: '08022222222' },
    }).catch(e => e);
    expect(err).toBeInstanceOf(ChowdeckError);
    expect(err.isDuplicateReference).toBe(true);
    expect(err.statusCode).toBe(400);
  });
  it('cancel sends the reason and reports the refund in naira', async () => {
    reply({ status: 'success', data: { status: 'cancelled', refund_amount: 80000 } });
    expect(await cancelChowdeckDelivery('ORD-1', 'Order refunded')).toEqual({ status: 'cancelled', refundNaira: 800 });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/relay/delivery/ORD-1/cancel', data: { reason: 'Order refunded' } });
  });
});
