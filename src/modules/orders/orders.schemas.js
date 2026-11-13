const { z } = require('zod');
const { pageQuery } = require('../../shared/http/schemas');
const { SUB_ORDER_STATUS } = require('./state-machine');

// Checkout takes no body: it orders the cart as it stands. An empty object
// keeps the Idempotency-Key hash stable.
const checkoutBody = z.object({}).strict();

const orderIdParams = z.object({ id: z.string().uuid('Invalid order id') });

const listOrdersQuery = pageQuery;

const vendorSubOrdersQuery = pageQuery.extend({
  status: z.enum(Object.values(SUB_ORDER_STATUS)).optional(),
});

const shipBody = z
  .object({
    courierName: z.string().trim().min(2).max(60),
    trackingNumber: z.string().trim().min(3).max(60),
  })
  .strict();

module.exports = {
  checkoutBody,
  orderIdParams,
  listOrdersQuery,
  vendorSubOrdersQuery,
  shipBody,
};
