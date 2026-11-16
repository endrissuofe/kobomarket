const { z } = require('zod');
const { idParams, pageQuery } = require('../../shared/http/schemas');
const { ROLES, USER_STATUS } = require('../users/user.model');
const { TRANSACTION_TYPES } = require('../ledger');

const usersQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(Object.values(ROLES)).optional(),
  status: z.enum(Object.values(USER_STATUS)).optional(),
});

const freezeBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

const walletParams = z.object({ id: z.string().uuid('Invalid wallet (account) id') });

const transactionsQuery = pageQuery.extend({
  type: z.enum(Object.values(TRANSACTION_TYPES)).optional(),
  reference: z.string().trim().min(1).max(200).optional(),
});

// Basis points: 500 = 5%. Capped at 50% so a typo cannot hand the platform
// the whole sale; the database allows up to 100%.
const commissionBody = z
  .object({ commissionBps: z.number().int('Whole basis points (500 = 5%)').min(0).max(5000) })
  .strict();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const revenueQuery = z
  .object({ from: date, to: date })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, {
    message: 'At most 366 days per request',
    path: ['to'],
  });

module.exports = {
  idParams,
  usersQuery,
  freezeBody,
  walletParams,
  transactionsQuery,
  commissionBody,
  revenueQuery,
};
