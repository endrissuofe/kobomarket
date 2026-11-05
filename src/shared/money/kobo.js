// All money is integer kobo (₦1 = 100 kobo). Never floats.

/** Parse a value (number or pg BIGINT string) into a safe integer of kobo. */
function toKobo(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`Invalid kobo amount: ${value}`);
  }
  return n;
}

/**
 * Split an amount by basis points (500 = 5%).
 * Commission rounds down; the vendor gets the remainder,
 * so the two parts always add back to the original amount.
 */
function splitByBps(amountKobo, bps) {
  const amount = toKobo(amountKobo);
  const commission = Math.floor((amount * bps) / 10000);
  return { commission, net: amount - commission };
}

/** Display only. Never use the result for maths. */
function formatNaira(amountKobo) {
  const k = toKobo(amountKobo);
  const naira = Math.trunc(k / 100);
  const rest = String(Math.abs(k % 100)).padStart(2, '0');
  return `₦${naira.toLocaleString('en-NG')}.${rest}`;
}

module.exports = { toKobo, splitByBps, formatNaira };
