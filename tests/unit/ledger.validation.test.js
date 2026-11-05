const { validatePosting } = require('../../src/modules/ledger/ledger.validation');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const posting = (entries, extra = {}) => ({
  reference: 'REF-1',
  type: 'FUNDING',
  entries,
  ...extra,
});
const debit = (accountId, amountKobo) => ({ accountId, direction: 'debit', amountKobo });
const credit = (accountId, amountKobo) => ({ accountId, direction: 'credit', amountKobo });

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'NO_ERROR';
}

describe('validatePosting', () => {
  test('accepts a balanced two-leg posting and returns per-account deltas', () => {
    const out = validatePosting(posting([debit(A, 5000), credit(B, 5000)]));
    expect(out.deltas.get(A)).toBe(-5000);
    expect(out.deltas.get(B)).toBe(5000);
    expect(out.metadata).toEqual({});
    expect(out.idempotencyKey).toBeNull();
  });

  test('accepts a balanced multi-leg split (escrow release with commission)', () => {
    const out = validatePosting(
      posting([debit(A, 10000), credit(B, 9500), credit(C, 500)], { type: 'ESCROW_RELEASE' }),
    );
    expect([...out.deltas.values()].reduce((s, d) => s + d, 0)).toBe(0);
  });

  test('nets entries on the same account', () => {
    const out = validatePosting(posting([debit(A, 300), credit(A, 100), credit(B, 200)]));
    expect(out.deltas.get(A)).toBe(-200);
  });

  test('rejects unbalanced postings with the totals', () => {
    let error;
    try {
      validatePosting(posting([debit(A, 5000), credit(B, 4999)]));
    } catch (err) {
      error = err;
    }
    expect(error.code).toBe('UNBALANCED_TRANSACTION');
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ debitsKobo: 5000, creditsKobo: 4999 });
  });

  test.each([
    ['float', 10.5],
    ['zero', 0],
    ['negative', -100],
    ['string', '100'],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', NaN],
  ])('rejects a %s amount', (_label, amount) => {
    expect(codeOf(() => validatePosting(posting([debit(A, amount), credit(B, amount)])))).toBe(
      'VALIDATION_ERROR',
    );
  });

  test('rejects fewer than two entries', () => {
    expect(codeOf(() => validatePosting(posting([credit(A, 100)])))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => validatePosting(posting([])))).toBe('VALIDATION_ERROR');
  });

  test('rejects an unknown type, missing reference, bad direction and bad metadata', () => {
    const ok = [debit(A, 1), credit(B, 1)];
    expect(codeOf(() => validatePosting(posting(ok, { type: 'GIFT' })))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => validatePosting(posting(ok, { reference: '  ' })))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => validatePosting(posting(ok, { metadata: [] })))).toBe('VALIDATION_ERROR');
    expect(
      codeOf(() =>
        validatePosting(posting([{ accountId: A, direction: 'in', amountKobo: 1 }, credit(B, 1)])),
      ),
    ).toBe('VALIDATION_ERROR');
  });

  test('rejects totals beyond the safe integer range', () => {
    const big = Number.MAX_SAFE_INTEGER - 1;
    expect(
      codeOf(() =>
        validatePosting(posting([debit(A, big), debit(A, big), credit(B, big), credit(B, big)])),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});
