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

  // Paystack transfer statuses -> ours. Anything not final stays pending and
  // is checked again on the next processor run.
  function mapTransfer(data) {
    const failed = ['failed', 'reversed', 'abandoned', 'rejected', 'blocked'];
    let status = 'pending';
    if (data.status === 'success') status = 'success';
    else if (failed.includes(data.status)) status = 'failed';
    return {
      status,
      providerRef: data.transfer_code || null,
      reason:
        status === 'failed' ? data.reason || data.failures || `Paystack: ${data.status}` : null,
    };
  }

  async function verifyTransfer(reference) {
    return mapTransfer(await call('GET', `/transfer/verify/${encodeURIComponent(reference)}`));
  }

  return {
    name: 'paystack',

    /**
     * Send money to a bank account. `reference` is our payout id: Paystack
     * refuses a second transfer with the same reference, so a retry after a
     * crash checks the first one instead of paying twice.
     */
    async transfer({ reference, amountKobo, bank, reason }) {
      const recipient = await call('POST', '/transferrecipient', {
        type: 'nuban',
        name: bank.accountName,
        account_number: bank.accountNumber,
        bank_code: bank.bankCode,
        currency: 'NGN',
      });
      try {
        const data = await call('POST', '/transfer', {
          source: 'balance',
          amount: amountKobo,
          recipient: recipient.recipient_code,
          reference,
          reason,
        });
        return mapTransfer(data);
      } catch (err) {
        if (/reference/i.test(err.message)) return verifyTransfer(reference);
        throw err;
      }
    },

    verifyTransfer,

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
