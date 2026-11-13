const { z } = require('zod');

// Checkout takes no body: it orders the cart as it stands. An empty object
// keeps the Idempotency-Key hash stable.
const checkoutBody = z.object({}).strict();

module.exports = { checkoutBody };
