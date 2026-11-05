// Pure checks on a posting, before any database work. No I/O here, so this
// file is unit-tested on its own.

const { AppError, validationError } = require('../../shared/errors');
const { TRANSACTION_TYPES, DIRECTIONS } = require('./ledger.constants');

const TYPES = new Set(Object.values(TRANSACTION_TYPES));
const DIRS = new Set(Object.values(DIRECTIONS));

/**
 * @typedef {{ accountId: string, direction: 'debit'|'credit', amountKobo: number }} Entry
 * @typedef {{ reference: string, type: string, entries: Entry[],
 *             metadata?: object, idempotencyKey?: string|null }} Posting
 */

/**
 * Validate a posting and return it normalised, plus the net change per account.
 * Throws VALIDATION_ERROR for malformed input and UNBALANCED_TRANSACTION when
 * debits and credits differ.
 *
 * @param {Posting} posting
 * @returns {Posting & { deltas: Map<string, number> }}
 */
function validatePosting(posting) {
  const problems = [];
  const { reference, type, entries, metadata = {}, idempotencyKey = null } = posting || {};

  if (typeof reference !== 'string' || reference.trim() === '') {
    problems.push({ path: 'reference', message: 'reference is required' });
  }
  if (!TYPES.has(type)) {
    problems.push({ path: 'type', message: `type must be one of ${[...TYPES].join(', ')}` });
  }
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || idempotencyKey === '')) {
    problems.push({ path: 'idempotencyKey', message: 'idempotencyKey must be a non-empty string' });
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    problems.push({ path: 'metadata', message: 'metadata must be an object' });
  }
  if (!Array.isArray(entries) || entries.length < 2) {
    problems.push({ path: 'entries', message: 'a transaction needs at least two entries' });
  }
  if (problems.length) throw validationError(problems);

  let debits = 0;
  let credits = 0;
  const deltas = new Map();

  entries.forEach((entry, i) => {
    const { accountId, direction, amountKobo } = entry || {};
    if (typeof accountId !== 'string' || accountId === '') {
      problems.push({ path: `entries.${i}.accountId`, message: 'accountId is required' });
    }
    if (!DIRS.has(direction)) {
      problems.push({
        path: `entries.${i}.direction`,
        message: "direction must be 'debit' or 'credit'",
      });
    }
    // Integer kobo only: no floats, no strings, no zero or negative amounts.
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      problems.push({
        path: `entries.${i}.amountKobo`,
        message: 'amountKobo must be a positive integer number of kobo',
      });
      return;
    }
    if (direction === DIRECTIONS.DEBIT) debits += amountKobo;
    if (direction === DIRECTIONS.CREDIT) credits += amountKobo;
    const signed = direction === DIRECTIONS.CREDIT ? amountKobo : -amountKobo;
    deltas.set(accountId, (deltas.get(accountId) || 0) + signed);
  });

  if (problems.length) throw validationError(problems);
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
    throw validationError([{ path: 'entries', message: 'total amount is too large' }]);
  }
  if (debits !== credits) {
    throw new AppError('UNBALANCED_TRANSACTION', 'Debits and credits must be equal', 422, {
      debitsKobo: debits,
      creditsKobo: credits,
    });
  }

  return {
    reference: reference.trim(),
    type,
    entries: entries.map(({ accountId, direction, amountKobo }) => ({
      accountId,
      direction,
      amountKobo,
    })),
    metadata,
    idempotencyKey,
    deltas,
  };
}

module.exports = { validatePosting };
