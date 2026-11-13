// Create products through the API for tests.
const { randomUUID } = require('node:crypto');
const request = require('supertest');

async function makeProduct(app, vendor, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/products')
    .set(vendor.auth)
    .send({
      name: `Test Product ${randomUUID().slice(0, 6)}`,
      category: 'test',
      priceKobo: 250000,
      stock: 10,
      ...overrides,
    });
  if (res.status !== 201)
    throw new Error(`product failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.product;
}

module.exports = { makeProduct };
