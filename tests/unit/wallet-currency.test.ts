import { normalizeCurrency } from '../../src/services/wallet.service';

describe('normalizeCurrency (Payluk sends "NG" sometimes)', () => {
  it('turns NG and blanks into NGN, keeps real codes', () => {
    expect(normalizeCurrency('NG')).toBe('NGN');
    expect(normalizeCurrency('ng')).toBe('NGN');
    expect(normalizeCurrency(undefined)).toBe('NGN');
    expect(normalizeCurrency('')).toBe('NGN');
    expect(normalizeCurrency('NGN')).toBe('NGN');
    expect(normalizeCurrency('USD')).toBe('USD');
    expect(normalizeCurrency('N1')).toBe('NGN');
  });
});
