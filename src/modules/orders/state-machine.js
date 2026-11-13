const { conflict } = require('../../shared/errors');

const SUB_ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DISPUTED: 'DISPUTED',
  REFUNDED: 'REFUNDED',
});

const S = SUB_ORDER_STATUS;

// The only allowed moves. Everything not listed is refused.
//   PENDING_PAYMENT -> PAID              checkout, same transaction as ESCROW_HOLD
//   PAID            -> CANCELLED         buyer cancels before shipping (REFUND)
//   PAID            -> SHIPPED           vendor, with courier + tracking number
//   SHIPPED         -> DELIVERED         buyer confirms
//   DELIVERED       -> COMPLETED         system, right after confirm (ESCROW_RELEASE)
//   SHIPPED         -> COMPLETED         auto-complete job after the timeout
//   SHIPPED/DELIVERED -> DISPUTED        buyer opens a dispute; escrow frozen
//   DISPUTED        -> REFUNDED          admin, full refund
//   DISPUTED        -> COMPLETED         admin, partial refund or rejected
const TRANSITIONS = Object.freeze({
  [S.PENDING_PAYMENT]: [S.PAID],
  [S.PAID]: [S.SHIPPED, S.CANCELLED],
  [S.SHIPPED]: [S.DELIVERED, S.COMPLETED, S.DISPUTED],
  [S.DELIVERED]: [S.COMPLETED, S.DISPUTED],
  [S.DISPUTED]: [S.REFUNDED, S.COMPLETED],
  [S.COMPLETED]: [],
  [S.CANCELLED]: [],
  [S.REFUNDED]: [],
});

const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

/** Throws 409 INVALID_TRANSITION unless from -> to is allowed. */
function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw conflict('INVALID_TRANSITION', `A sub-order cannot go from ${from} to ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from] ?? [],
    });
  }
}

/**
 * The order's status, derived from its sub-orders: the status they all share,
 * or IN_PROGRESS when they differ (each sub-order then shows its own).
 */
function orderStatus(subOrderStatuses) {
  const unique = [...new Set(subOrderStatuses)];
  return unique.length === 1 ? unique[0] : 'IN_PROGRESS';
}

module.exports = { SUB_ORDER_STATUS, TRANSITIONS, canTransition, assertTransition, orderStatus };
