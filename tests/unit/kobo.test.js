process.env.NODE_ENV = 'test';
const { toKobo, splitByBps, formatNaira } = require('../../src/shared/money/kobo');

describe('kobo helpers', () => {
  test('rejects floats and unsafe numbers', () => {
    expect(() => toKobo(10.5)).toThrow();
    expect(() => toKobo(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  test('parses pg BIGINT strings', () => {
    expect(toKobo('125000')).toBe(125000);
  });

  test('commission split never loses a kobo', () => {
    for (const amount of [1, 99, 101, 333333, 1250000]) {
      const { commission, net } = splitByBps(amount, 500);
      expect(commission + net).toBe(amount);
    }
  });

  test('formats naira for display', () => {
    expect(formatNaira(1250000)).toBe('₦12,500.00');
  });
});
