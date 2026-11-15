import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMinorAmount } from './money';

describe('formatMinorAmount', () => {
  it('uses each currency exponent and clamps caller decimals', () => {
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('kwd')).toBe(3);

    expect(
      formatMinorAmount(1234, 'jpy', {
        locale: 'en-US',
        minimumFractionDigits: 2,
      }),
    ).toBe('¥1,234');
    expect(
      formatMinorAmount(1234, 'usd', {
        locale: 'en-US',
        minimumFractionDigits: 2,
      }),
    ).toBe('$12.34');
    expect(
      formatMinorAmount(1234, 'kwd', { locale: 'en-US' }),
    ).toBe('KWD\u00a01.234');
  });
});
