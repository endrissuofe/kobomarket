const { sign, isValidSignature } = require('../../src/integrations/payments/signature');
const { createPaystackProvider } = require('../../src/integrations/payments/paystack');

const SECRET = 'sk_test_unit';

describe('webhook signature (HMAC-SHA512)', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'R1', amount: 5000 } });

  test('accepts the signature of the exact body', () => {
    expect(isValidSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  test.each([
    ['a missing signature', body, undefined],
    ['an empty signature', body, ''],
    ['a signature of a different body', body.replace('5000', '500000'), sign(body, SECRET)],
    ['a signature made with another secret', body, sign(body, 'sk_test_other')],
    ['a truncated signature', body, sign(body, SECRET).slice(0, 64)],
    ['a non-hex signature', body, 'z'.repeat(128)],
  ])('rejects %s', (_label, rawBody, signature) => {
    expect(isValidSignature(rawBody, signature, SECRET)).toBe(false);
  });

  test('rejects everything when no secret is configured', () => {
    expect(isValidSignature(body, sign(body, ''), '')).toBe(false);
  });
});

describe('Paystack provider (HTTP faked)', () => {
  function fakeFetch(status, json) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => json };
    };
    return { impl, calls };
  }
  const provider = (fetchImpl) =>
    createPaystackProvider({ secretKey: SECRET, baseUrl: 'https://api.paystack.test', fetchImpl });

  test('initialize sends the amount in kobo with the secret key', async () => {
    const { impl, calls } = fakeFetch(200, {
      status: true,
      data: { authorization_url: 'https://checkout.paystack.com/abc', reference: 'KM-1' },
    });
    const out = await provider(impl).initialize({
      email: 'a@b.co',
      amountKobo: 250000,
      reference: 'KM-1',
    });

    expect(out).toEqual({
      authorizationUrl: 'https://checkout.paystack.com/abc',
      reference: 'KM-1',
    });
    expect(calls[0].url).toBe('https://api.paystack.test/transaction/initialize');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      email: 'a@b.co',
      amount: 250000,
      currency: 'NGN',
      reference: 'KM-1',
    });
  });

  test('verify maps the response', async () => {
    const { impl, calls } = fakeFetch(200, {
      status: true,
      data: { status: 'success', amount: 250000, currency: 'NGN', reference: 'KM-1', paid_at: 'T' },
    });
    expect(await provider(impl).verify('KM-1')).toEqual({
      status: 'success',
      amountKobo: 250000,
      currency: 'NGN',
      reference: 'KM-1',
      paidAt: 'T',
    });
    expect(calls[0].url).toBe('https://api.paystack.test/transaction/verify/KM-1');
  });

  test('a Paystack error becomes a 502 PAYMENT_PROVIDER_ERROR', async () => {
    const { impl } = fakeFetch(400, { status: false, message: 'Transaction reference not found' });
    await expect(provider(impl).verify('nope')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
      status: 502,
      message: 'Transaction reference not found',
    });
  });

  test('a network failure becomes a 502', async () => {
    const impl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(provider(impl).verify('KM-1')).rejects.toMatchObject({ status: 502 });
  });

  test('a non-integer amount from Paystack is refused, never rounded', async () => {
    const { impl } = fakeFetch(200, {
      status: true,
      data: { status: 'success', amount: 2500.5, currency: 'NGN', reference: 'KM-1' },
    });
    await expect(provider(impl).verify('KM-1')).rejects.toMatchObject({ status: 502 });
  });
});

describe('mock provider', () => {
  const { createMockProvider } = require('../../src/integrations/payments/mock');

  test('a restarted mock does not reuse event ids (webhook_events dedupes on them)', async () => {
    const before = createMockProvider({ secretKey: SECRET });
    await before.initialize({ email: 'a@b.co', amountKobo: 100, reference: 'R-A' });
    await new Promise((r) => setTimeout(r, 2));
    const afterRestart = createMockProvider({ secretKey: SECRET });
    await afterRestart.initialize({ email: 'a@b.co', amountKobo: 100, reference: 'R-B' });

    const idOf = (p, ref) => JSON.parse(p.chargeSuccessEvent(ref)).data.id;
    expect(idOf(afterRestart, 'R-B')).toBeGreaterThan(idOf(before, 'R-A'));
  });
});

describe('transfers', () => {
  const { createMockProvider } = require('../../src/integrations/payments/mock');
  const bank = (accountNumber) => ({ bankCode: '058', accountNumber, accountName: 'Ada Store' });

  test('mock: succeeds, and the same reference returns the same transfer', async () => {
    const mock = createMockProvider({ secretKey: SECRET });
    const first = await mock.transfer({
      reference: 'p-1',
      amountKobo: 500000,
      bank: bank('0123456789'),
    });
    const again = await mock.transfer({
      reference: 'p-1',
      amountKobo: 500000,
      bank: bank('0123456789'),
    });
    expect(first).toMatchObject({ status: 'success', reason: null });
    expect(again.providerRef).toBe(first.providerRef);
  });

  test('mock: an account number ending in 0000 fails with a reason', async () => {
    const mock = createMockProvider({ secretKey: SECRET });
    const out = await mock.transfer({
      reference: 'p-2',
      amountKobo: 500000,
      bank: bank('0123450000'),
    });
    expect(out).toMatchObject({ status: 'failed', reason: expect.stringContaining('0000') });
  });

  test('Paystack: creates a recipient, then a transfer with our reference, amount in kobo', async () => {
    const calls = [];
    const responses = [
      { status: true, data: { recipient_code: 'RCP_1' } },
      { status: true, data: { status: 'success', transfer_code: 'TRF_1' } },
    ];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: init.body && JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => responses.shift() };
    };
    const paystack = createPaystackProvider({ secretKey: SECRET, baseUrl: 'https://x', fetchImpl });
    const out = await paystack.transfer({
      reference: 'pay-uuid',
      amountKobo: 250000,
      bank: bank('0123456789'),
      reason: 'KoboMarket payout',
    });
    expect(out).toEqual({ status: 'success', providerRef: 'TRF_1', reason: null });
    expect(calls[0]).toMatchObject({
      url: 'https://x/transferrecipient',
      body: { bank_code: '058' },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://x/transfer',
      body: { amount: 250000, recipient: 'RCP_1', reference: 'pay-uuid' },
    });
  });

  test('Paystack: a duplicate reference is checked with verify instead of paying twice', async () => {
    const urls = [];
    const responses = [
      [200, { status: true, data: { recipient_code: 'RCP_1' } }],
      [400, { status: false, message: 'Transfer reference already exists' }],
      [200, { status: true, data: { status: 'reversed', transfer_code: 'TRF_9' } }],
    ];
    const fetchImpl = async (url) => {
      urls.push(url);
      const [code, json] = responses.shift();
      return { ok: code < 300, status: code, json: async () => json };
    };
    const paystack = createPaystackProvider({ secretKey: SECRET, baseUrl: 'https://x', fetchImpl });
    const out = await paystack.transfer({
      reference: 'pay-uuid',
      amountKobo: 1,
      bank: bank('0123456789'),
    });
    expect(urls.at(-1)).toBe('https://x/transfer/verify/pay-uuid');
    expect(out).toMatchObject({ status: 'failed', providerRef: 'TRF_9' });
  });
});
