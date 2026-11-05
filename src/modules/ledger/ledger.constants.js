// Names shared by the ledger module and its callers.
// System account names must match migrations/*_seed_system_accounts.js.

const SYSTEM_ACCOUNTS = Object.freeze({
  PLATFORM_ESCROW: 'PLATFORM_ESCROW',
  PLATFORM_REVENUE: 'PLATFORM_REVENUE',
  PLATFORM_PAYOUT_CLEARING: 'PLATFORM_PAYOUT_CLEARING',
  EXTERNAL_PAYSTACK: 'EXTERNAL_PAYSTACK',
});

// The only account allowed to go negative: money that came in from outside.
const ACCOUNTS_ALLOWED_NEGATIVE = Object.freeze([SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK]);

// Must match the CHECK on transactions.type.
const TRANSACTION_TYPES = Object.freeze({
  FUNDING: 'FUNDING',
  ESCROW_HOLD: 'ESCROW_HOLD',
  ESCROW_RELEASE: 'ESCROW_RELEASE',
  REFUND: 'REFUND',
  PAYOUT_HOLD: 'PAYOUT_HOLD',
  PAYOUT_SETTLE: 'PAYOUT_SETTLE',
  PAYOUT_REVERSAL: 'PAYOUT_REVERSAL',
});

// Credit increases a balance, debit decreases it.
const DIRECTIONS = Object.freeze({ DEBIT: 'debit', CREDIT: 'credit' });

const OWNER_TYPES = Object.freeze({ USER: 'USER', SYSTEM: 'SYSTEM' });

module.exports = {
  SYSTEM_ACCOUNTS,
  ACCOUNTS_ALLOWED_NEGATIVE,
  TRANSACTION_TYPES,
  DIRECTIONS,
  OWNER_TYPES,
};
