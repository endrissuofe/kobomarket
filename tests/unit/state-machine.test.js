const {
  SUB_ORDER_STATUS: S,
  TRANSITIONS,
  assertTransition,
  canTransition,
  orderStatus,
} = require('../../src/modules/orders/state-machine');

const ALL = Object.values(S);
const ALLOWED = [
  ['PENDING_PAYMENT', 'PAID'],
  ['PAID', 'SHIPPED'],
  ['PAID', 'CANCELLED'],
  ['SHIPPED', 'DELIVERED'],
  ['SHIPPED', 'COMPLETED'],
  ['SHIPPED', 'DISPUTED'],
  ['DELIVERED', 'COMPLETED'],
  ['DELIVERED', 'DISPUTED'],
  ['DISPUTED', 'REFUNDED'],
  ['DISPUTED', 'COMPLETED'],
];

describe('sub-order state machine', () => {
  test('allows exactly the listed transitions, nothing else', () => {
    const allowed = new Set(ALLOWED.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  // Required test 10 (unit level; the endpoint is tested in the orders tests)
  test.each([
    ['PAID', 'COMPLETED'],
    ['PENDING_PAYMENT', 'COMPLETED'],
    ['PAID', 'DELIVERED'],
    ['COMPLETED', 'REFUNDED'],
    ['CANCELLED', 'PAID'],
    ['DISPUTED', 'CANCELLED'],
  ])('%s -> %s is rejected with 409 INVALID_TRANSITION', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION', status: 409 }),
    );
  });

  test('terminal states go nowhere', () => {
    for (const s of ['COMPLETED', 'CANCELLED', 'REFUNDED']) expect(TRANSITIONS[s]).toEqual([]);
  });

  test('order status: shared status, or IN_PROGRESS when sub-orders differ', () => {
    expect(orderStatus(['PAID', 'PAID'])).toBe('PAID');
    expect(orderStatus(['PAID', 'SHIPPED'])).toBe('IN_PROGRESS');
    expect(orderStatus(['COMPLETED'])).toBe('COMPLETED');
  });
});
