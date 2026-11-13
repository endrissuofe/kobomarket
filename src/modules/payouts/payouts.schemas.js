const { z } = require('zod');
const { pageQuery } = require('../../shared/http/schemas');

// Integer kobo, no coercion. The minimum is the live payout_min_kobo setting
// (admin-editable), so it is checked in the service, not here.
const requestBody = z
  .object({
    amountKobo: z
      .number({ invalid_type_error: 'amountKobo must be a number in kobo' })
      .int('amountKobo must be whole kobo (no decimals)')
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const listQuery = pageQuery;

module.exports = { requestBody, listQuery };
