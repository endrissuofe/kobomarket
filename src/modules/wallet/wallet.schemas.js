const { z } = require('zod');
const { pageQuery } = require('../../shared/http/schemas');
const { MIN_FUNDING_KOBO, MAX_FUNDING_KOBO } = require('./wallet.constants');

// A JSON integer in kobo. Strings and decimals are refused, never coerced.
const fundBody = z
  .object({
    amountKobo: z
      .number({ invalid_type_error: 'amountKobo must be a number in kobo' })
      .int('amountKobo must be whole kobo (no decimals)')
      .min(MIN_FUNDING_KOBO, `Minimum is ${MIN_FUNDING_KOBO} kobo (₦100)`)
      .max(MAX_FUNDING_KOBO, `Maximum is ${MAX_FUNDING_KOBO} kobo (₦10,000,000)`),
  })
  .strict();

const transactionsQuery = pageQuery;

module.exports = { fundBody, transactionsQuery };
