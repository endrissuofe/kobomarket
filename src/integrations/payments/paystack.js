const { providerError } = require('./errors');

const TIMEOUT_MS = 10_000;

/**
 * Paystack (test mode) over HTTPS. Amounts are kobo on both sides.
 * Both calls happen outside any database transaction.
 *
 * Interface shared with the mock provider:
 *   initialize({ email, amountKobo, reference, callbackUrl }) -> { authorizationUrl }
 *   verify(reference) -> { status, amountKobo, currency, reference, paidAt }
 *     status is Paystack's: 'success', 'failed', 'abandoned', 'pending', ...
 */
function createPaystackProvider({ secretKey, baseUrl, fetchImpl = fetch }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError('Could not reach Paystack', { cause: err.name });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.status) {
      throw providerError(json?.message || `Paystack returned ${res.status}`, {
        httpStatus: res.status,
      });
    }
    return json.data;
  }

  return {
    name: 'paystack',

    async initialize({ email, amountKobo, reference, callbackUrl }) {
      const data = await call('POST', '/transaction/initialize', {
        email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        ...(callbackUrl && { callback_url: callbackUrl }),
      });
      return { authorizationUrl: data.authorization_url, reference: data.reference };
    },

    async verify(reference) {
      const data = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      if (!Number.isSafeInteger(data.amount)) {
        throw providerError('Paystack returned a non-integer amount', { reference });
      }
      return {
        status: data.status,
        amountKobo: data.amount,
        currency: data.currency,
        reference: data.reference,
        paidAt: data.paid_at || null,
      };
    },
  };
}

module.exports = { createPaystackProvider };
