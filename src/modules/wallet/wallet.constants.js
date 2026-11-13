// Funding limits per request, integer kobo.
const MIN_FUNDING_KOBO = 10_000; // ₦100
const MAX_FUNDING_KOBO = 1_000_000_000; // ₦10,000,000

const FUNDING_STATUS = Object.freeze({
  INITIATED: 'INITIATED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
});

module.exports = { MIN_FUNDING_KOBO, MAX_FUNDING_KOBO, FUNDING_STATUS };
