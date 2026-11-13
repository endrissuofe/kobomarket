// Checkout test helpers: a buyer with a funded wallet and items in the cart.
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { LedgerService } = require('../../src/modules/ledger');
const { fund } = require('./ledger');
const { signIn } = require('./auth');

/** A signed-in buyer whose wallet holds balanceKobo (funded through the ledger). */
async function fundedBuyer(app, balanceKobo) {
  const buyer = await signIn(app);
  const account = await LedgerService.findUserAccount(buyer.userId);
  if (balanceKobo > 0) await fund(account.id, balanceKobo);
  return { ...buyer, accountId: account.id };
}

async function addToCart(app, buyer, productId, qty = 1, variantSku) {
  const res = await request(app)
    .post('/api/v1/cart/items')
    .set(buyer.auth)
    .send({ productId, qty, ...(variantSku && { variantSku }) });
  if (res.status !== 201) throw new Error(`add to cart: ${res.status} ${JSON.stringify(res.body)}`);
}

const checkout = (app, buyer, key = randomUUID()) =>
  request(app).post('/api/v1/orders/checkout').set(buyer.auth).set('Idempotency-Key', key).send({});

const balanceOf = async (accountId) => (await LedgerService.getAccount(accountId)).balanceKobo;

module.exports = { fundedBuyer, addToCart, checkout, balanceOf };
