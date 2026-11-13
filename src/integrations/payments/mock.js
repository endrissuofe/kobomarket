const { sign } = require('./signature');
const { providerError } = require('./errors');

/**
 * A stand-in for Paystack that behaves the same way from the app's side:
 * initialize returns a checkout URL; "paying" there marks the payment
 * successful and sends a signed charge.success webhook, twice, because
 * Paystack may deliver an event more than once. verify reports what was paid.
 *
 * State is in memory in the API process, which is enough for development,
 * the demo and tests.
 */
function createMockProvider({ secretKey, fetchImpl = fetch }) {
  const payments = new Map();
  let nextId = 1_000_000;

  function get(reference) {
    const payment = payments.get(reference);
    if (!payment) throw providerError('Transaction reference not found', { reference });
    return payment;
  }

  /** The body Paystack sends for charge.success, as a raw JSON string. */
  function chargeSuccessEvent(payment) {
    return JSON.stringify({
      event: 'charge.success',
      data: {
        id: payment.id,
        reference: payment.reference,
        amount: payment.amountKobo,
        currency: 'NGN',
        status: 'success',
        paid_at: payment.paidAt,
        customer: { email: payment.email },
      },
    });
  }

  return {
    name: 'mock',

    async initialize({ email, amountKobo, reference }) {
      payments.set(reference, {
        id: nextId++,
        reference,
        email,
        amountKobo,
        status: 'pending',
        paidAt: null,
      });
      // The API serves this page itself (mounted only with the mock provider).
      return { authorizationUrl: `/mock-paystack/checkout/${reference}`, reference };
    },

    async verify(reference) {
      const p = get(reference);
      return {
        status: p.status,
        amountKobo: p.amountKobo,
        currency: 'NGN',
        reference,
        paidAt: p.paidAt,
      };
    },

    describe(reference) {
      const { email, amountKobo, status } = get(reference);
      return { reference, email, amountKobo, status };
    },

    /**
     * The buyer pays on the mock checkout page. Delivers the signed webhook
     * `deliveries` times to webhookUrl and returns each delivery's HTTP status.
     */
    async pay(reference, { webhookUrl, deliveries = 2 }) {
      const p = get(reference);
      if (p.status === 'pending') {
        p.status = 'success';
        p.paidAt = new Date().toISOString();
      }
      const body = chargeSuccessEvent(p);
      const headers = {
        'Content-Type': 'application/json',
        'x-paystack-signature': sign(body, secretKey),
      };
      const statuses = [];
      for (let i = 0; i < deliveries; i += 1) {
        const res = await fetchImpl(webhookUrl, { method: 'POST', headers, body });
        statuses.push(res.status);
      }
      return statuses;
    },

    /** Test helper: make verify report something different from what was charged. */
    tamper(reference, changes) {
      Object.assign(get(reference), changes);
    },

    chargeSuccessEvent: (reference) => chargeSuccessEvent(get(reference)),
  };
}

module.exports = { createMockProvider };
