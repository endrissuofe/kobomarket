const { AppError } = require('../../shared/errors');

/** The payment provider failed or answered in a way we cannot use. */
const providerError = (message, details) =>
  new AppError('PAYMENT_PROVIDER_ERROR', message, 502, details);

module.exports = { providerError };
