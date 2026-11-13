const { productsRepository } = require('./products.repository');
const { compensationsRepository } = require('../compensations/compensations.repository');
const { COMPENSATION_TYPES } = require('../compensations/compensation.model');
const { conflict } = require('../../shared/errors');
const { logger } = require('../../shared/logger');

/**
 * Put stock back for each line. Never throws: a line that cannot be released
 * is recorded as a STOCK_RELEASE compensation for the reconciler to retry.
 * @param {{ productId: string, variantSku: string|null, qty: number }[]} lines
 */
async function release(lines, reason) {
  for (const line of lines) {
    try {
      const ok = await productsRepository.releaseStock(line);
      if (!ok) throw new Error('product not found');
    } catch (err) {
      logger.error({ err, line, reason }, 'Stock release failed; recorded for retry');
      await compensationsRepository
        .record({
          type: COMPENSATION_TYPES.STOCK_RELEASE,
          payload: line,
          reason,
          error: err.message,
        })
        .catch((e) => logger.fatal({ err: e, line }, 'Could not record compensation'));
    }
  }
}

/**
 * Reserve stock for every line, or none: if one line is short, the lines
 * already reserved are released and 409 OUT_OF_STOCK names the short line.
 */
async function reserve(lines, reason) {
  const reserved = [];
  for (const line of lines) {
    let ok = false;
    try {
      ok = await productsRepository.reserveStock(line);
    } catch (err) {
      await release(reserved, `${reason}: rollback after error`);
      throw err;
    }
    if (!ok) {
      await release(reserved, `${reason}: rollback after OUT_OF_STOCK`);
      throw conflict('OUT_OF_STOCK', 'An item in your cart just sold out', {
        productId: line.productId,
        variantSku: line.variantSku,
      });
    }
    reserved.push(line);
  }
  return reserved;
}

module.exports = { stockService: { reserve, release } };
