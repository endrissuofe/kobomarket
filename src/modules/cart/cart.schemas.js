const { z } = require('zod');
const { objectId } = require('../../shared/http/schemas');
const { MAX_LINE_QTY } = require('./cart.model');

const qty = z.number().int('qty must be a whole number').min(1).max(MAX_LINE_QTY);

const addItemBody = z
  .object({
    productId: objectId,
    variantSku: z.string().trim().min(1).max(64).optional(),
    qty: qty.default(1),
  })
  .strict();

const updateItemBody = z.object({ qty }).strict();

const itemParams = z.object({ itemId: objectId });

module.exports = { addItemBody, updateItemBody, itemParams };
