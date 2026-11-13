const { randomUUID } = require('node:crypto');
const { db, withTransaction } = require('../../db/postgres');
const { AppError, badRequest, conflict, forbidden, notFound } = require('../../shared/errors');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { approvedStoreOf } = require('../products/products.service');
const { logger } = require('../../shared/logger');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../ledger');
const { walletOf } = require('../wallet/wallet.service');
const { cartService, LINE_PROBLEMS } = require('../cart/cart.service');
const { stockService } = require('../products/stock.service');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { VENDOR_STATUS } = require('../vendors/vendor.model');
const { USER_STATUS } = require('../users/user.model');
const { settingsService } = require('../settings/settings.service');
const { outboxRepository, OUTBOX_EVENTS } = require('../outbox/outbox.repository');
const { ordersRepository } = require('./orders.repository');
const { SUB_ORDER_STATUS: S, assertTransition, orderStatus } = require('./state-machine');

const accountFrozen = () => forbidden('Your account is frozen', 'ACCOUNT_FROZEN');

/**
 * Move a locked sub-order to a new status and record it in the history.
 * `fields` are extra columns to set (snake_case), e.g. shipped_at.
 */
async function transition(trx, subOrder, to, { actorId, reason, fields = {} }) {
  assertTransition(subOrder.status, to);
  const updated = await ordersRepository.updateSubOrder(trx, subOrder.id, {
    status: to,
    ...fields,
  });
  await ordersRepository.addHistory(trx, {
    subOrderId: subOrder.id,
    from: subOrder.status,
    to,
    actorId,
    reason,
  });
  return updated;
}

/** Group lines by vendor, looking up each store's owner (whose wallet is paid). */
async function groupByVendor(buyer, lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.vendorId))
      groups.set(line.vendorId, { vendorId: line.vendorId, lines: [] });
    groups.get(line.vendorId).lines.push(line);
  }
  for (const group of groups.values()) {
    const vendor = await vendorsRepository.findById(group.vendorId);
    if (!vendor || vendor.status !== VENDOR_STATUS.APPROVED) {
      throw conflict('VENDOR_UNAVAILABLE', 'A store in your cart is no longer selling', {
        vendorId: group.vendorId,
      });
    }
    if (String(vendor.userId) === buyer.id) {
      throw forbidden('You cannot buy from your own store', 'CANNOT_BUY_OWN_PRODUCT');
    }
    group.vendorUserId = String(vendor.userId);
    group.subtotalKobo = group.lines.reduce((sum, l) => sum + l.unitPriceKobo * l.qty, 0);
  }
  return [...groups.values()];
}

/**
 * Place an order for explicit lines (the core of checkout).
 *
 * 1. Reserve stock in MongoDB (all lines or none). No money moves yet.
 * 2. One Postgres transaction: ESCROW_HOLD buyer -> PLATFORM_ESCROW first
 *    (LedgerService locks the wallet row and refuses INSUFFICIENT_FUNDS),
 *    then the order, one sub-order per vendor, items with price snapshots,
 *    PENDING_PAYMENT -> PAID, and an order.placed outbox event.
 * 3. If step 2 fails, the reserved stock is released (compensation).
 *
 * @param {{ id: string, status: string, walletStatus: string }} buyer
 * @param {{ productId, variantSku, qty, unitPriceKobo, name, vendorId }[]} lines
 */
async function placeOrder(buyer, lines, { idempotencyKey } = {}) {
  if (buyer.status === USER_STATUS.FROZEN) throw accountFrozen();
  const account = await walletOf(buyer);
  const groups = await groupByVendor(buyer, lines);
  const totalKobo = groups.reduce((sum, g) => sum + g.subtotalKobo, 0);

  const stockLines = lines.map((l) => ({
    productId: l.productId,
    variantSku: l.variantSku ?? null,
    qty: l.qty,
  }));
  await stockService.reserve(stockLines, `checkout by ${buyer.id}`);

  let orderId;
  try {
    orderId = await withTransaction(async (trx) => {
      // Money first, inside the transaction: LedgerService.post takes the
      // FOR UPDATE locks on the wallet and escrow rows before anything else.
      // Inserting the order earlier would take a foreign-key share lock on the
      // wallet row first, and two parallel checkouts would then deadlock
      // upgrading it. It also refuses INSUFFICIENT_FUNDS before any write.
      const id = randomUUID();
      const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW, trx);
      const { transaction } = await LedgerService.post(
        {
          reference: `ORD-${id}`,
          type: TRANSACTION_TYPES.ESCROW_HOLD,
          entries: [
            { accountId: account.id, direction: 'debit', amountKobo: totalKobo },
            { accountId: escrow.id, direction: 'credit', amountKobo: totalKobo },
          ],
          metadata: { orderId: id, buyerId: buyer.id },
        },
        trx,
      );

      const { commissionBps } = await settingsService.getBusinessSettings(trx);
      const order = await ordersRepository.insertOrder(trx, {
        id,
        buyerId: buyer.id,
        buyerAccountId: account.id,
        totalKobo,
        idempotencyKey,
        escrowTxnId: transaction.id,
      });

      const subOrders = [];
      for (const group of groups) {
        const sub = await ordersRepository.insertSubOrder(trx, {
          orderId: order.id,
          vendorId: group.vendorId,
          vendorUserId: group.vendorUserId,
          subtotalKobo: group.subtotalKobo,
          commissionBps,
        });
        await ordersRepository.insertItems(trx, sub.id, group.lines);
        await ordersRepository.addHistory(trx, {
          subOrderId: sub.id,
          to: S.PENDING_PAYMENT,
          actorId: buyer.id,
          reason: 'order created',
        });
        subOrders.push(sub);
      }

      for (const sub of subOrders) {
        await transition(trx, sub, S.PAID, { actorId: buyer.id, reason: 'escrow held' });
      }

      await outboxRepository.add(trx, {
        aggregate: 'order',
        aggregateId: order.id,
        eventType: OUTBOX_EVENTS.ORDER_PLACED,
        payload: {
          orderId: order.id,
          buyerId: buyer.id,
          totalKobo,
          subOrders: subOrders.map((s) => ({
            id: s.id,
            vendorId: s.vendorId,
            vendorUserId: s.vendorUserId,
          })),
        },
      });
      return order.id;
    });
  } catch (err) {
    await stockService.release(stockLines, `checkout failed (${err.code || err.message})`);
    throw err;
  }

  return getOrder(orderId);
}

/**
 * Check out the buyer's cart. The cart is reviewed exactly as GET /cart shows
 * it; any problem stops checkout before stock or money is touched. Lines whose
 * price changed are updated to the live price, so the buyer has now seen it
 * and can check out again (with a new Idempotency-Key).
 */
async function checkout(buyer, { idempotencyKey }) {
  if (buyer.status === USER_STATUS.FROZEN) throw accountFrozen();

  const cart = await cartService.review(buyer.id);
  if (cart.items.length === 0) {
    throw new AppError('CART_EMPTY', 'Your cart is empty', 422);
  }
  if (!cart.ready) {
    await cartService.acceptPrices(buyer.id, cart.items);
    const problems = cart.items.filter((i) => i.problems.length > 0);
    const onlyPrices = problems.every((i) =>
      i.problems.every((p) => p === LINE_PROBLEMS.PRICE_CHANGED),
    );
    throw conflict(
      'CART_NOT_READY',
      onlyPrices
        ? 'Some prices changed. Review your cart and check out again.'
        : 'Some items in your cart need attention',
      {
        items: problems.map((i) => ({
          id: i.id,
          productId: i.productId,
          problems: i.problems,
          unitPriceKobo: i.unitPriceKobo,
          availableStock: i.availableStock,
        })),
      },
    );
  }

  const lines = cart.items.map((i) => ({
    productId: i.productId,
    variantSku: i.variantSku,
    qty: i.qty,
    unitPriceKobo: i.unitPriceKobo,
    name: i.name,
    vendorId: i.vendorId,
  }));
  const order = await placeOrder(buyer, lines, { idempotencyKey });

  await cartService
    .removeOrderedLines(
      buyer.id,
      cart.items.map((i) => i.id),
    )
    .catch((err) => logger.warn({ err, orderId: order.id }, 'Could not clear ordered cart lines'));
  return order;
}

// --- Reads ---

function toView(order, subOrders) {
  return {
    ...order,
    status: orderStatus(subOrders.map((s) => s.status)),
    subOrders,
  };
}

async function getOrder(orderId, conn = db) {
  const order = await ordersRepository.findOrder(conn, orderId);
  if (!order) throw notFound('Order');
  return toView(order, await ordersRepository.findSubOrdersWithItems(conn, [order.id]));
}

// Postgres timestamptz text, e.g. "2026-11-13 16:30:58.384123+00".
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor of { t: created_at text, id: uuid }, checked before it reaches SQL. */
function readTimeCursor(raw) {
  const cursor = decodeCursor(raw);
  if (!cursor) return null;
  if (!PG_TIMESTAMP.test(String(cursor.t)) || !UUID.test(String(cursor.id))) {
    throw badRequest('Invalid cursor');
  }
  return cursor;
}

const timeCursor = (row) => ({ t: row.cursorTime, id: row.id });
const withoutCursor = ({ cursorTime: _ignored, ...rest }) => rest;

/** The buyer's own order. Someone else's order is a 404, not a 403. */
async function getOrderForBuyer(buyer, orderId) {
  const order = await ordersRepository.findOrder(db, orderId);
  if (!order || order.buyerId !== buyer.id) throw notFound('Order');
  return getOrder(order.id);
}

async function listOrdersForBuyer(buyer, { limit, cursor }) {
  const after = readTimeCursor(cursor);
  const rows = await ordersRepository.listOrdersForBuyer(db, buyer.id, { after, limit: limit + 1 });
  const page = paginate(rows, limit, timeCursor);
  const subs = await ordersRepository.findSubOrdersWithItems(
    db,
    page.items.map((o) => o.id),
  );
  return {
    items: page.items.map((o) =>
      toView(
        withoutCursor(o),
        subs.filter((x) => x.orderId === o.id),
      ),
    ),
    nextCursor: page.nextCursor,
  };
}

/** The vendor's sub-orders (their side of each order), newest first. */
async function listSubOrdersForVendor(user, { status, limit, cursor }) {
  const store = await approvedStoreOf(user);
  const after = readTimeCursor(cursor);
  const rows = await ordersRepository.listSubOrdersForVendor(db, String(store._id), {
    status,
    after,
    limit: limit + 1,
  });
  const page = paginate(rows, limit, timeCursor);
  return { items: page.items.map(withoutCursor), nextCursor: page.nextCursor };
}

/**
 * Cancel an order before anything has shipped. All or nothing: every
 * sub-order must still be PAID, otherwise 409 and nothing changes. One REFUND
 * moves the whole amount from escrow back to the buyer; stock is put back
 * after the transaction commits (a failed restock becomes a compensation).
 */
async function cancelOrder(buyer, orderId) {
  const order = await ordersRepository.findOrder(db, orderId);
  if (!order || order.buyerId !== buyer.id) throw notFound('Order');

  const cancelledIds = await withTransaction(async (trx) => {
    // Lock order: sub-orders first, then (inside post) the accounts.
    const subOrders = await ordersRepository.lockSubOrdersOfOrder(trx, order.id);
    const notPaid = subOrders.filter((s) => s.status !== S.PAID);
    if (notPaid.length > 0) {
      throw conflict(
        'ORDER_NOT_CANCELLABLE',
        'Only orders where nothing has shipped yet can be cancelled',
        { subOrders: subOrders.map((s) => ({ id: s.id, status: s.status })) },
      );
    }

    const refundKobo = subOrders.reduce((sum, s) => sum + s.subtotalKobo, 0);
    const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW, trx);
    const { transaction } = await LedgerService.post(
      {
        reference: `ORD-${order.id}-CANCEL`,
        type: TRANSACTION_TYPES.REFUND,
        entries: [
          { accountId: escrow.id, direction: 'debit', amountKobo: refundKobo },
          { accountId: order.buyerAccountId, direction: 'credit', amountKobo: refundKobo },
        ],
        metadata: { orderId: order.id, reason: 'buyer cancelled' },
      },
      trx,
    );

    for (const sub of subOrders) {
      await transition(trx, sub, S.CANCELLED, {
        actorId: buyer.id,
        reason: 'buyer cancelled before shipping',
        fields: { cancelled_at: trx.fn.now(), refund_txn_id: transaction.id },
      });
    }
    await outboxRepository.add(trx, {
      aggregate: 'order',
      aggregateId: order.id,
      eventType: OUTBOX_EVENTS.ORDER_CANCELLED,
      payload: {
        orderId: order.id,
        buyerId: buyer.id,
        refundKobo,
        subOrders: subOrders.map((s) => ({ id: s.id, vendorUserId: s.vendorUserId })),
      },
    });
    return subOrders.map((s) => s.id);
  });

  const items = await ordersRepository.itemsOfSubOrders(db, cancelledIds);
  await stockService.release(
    items.map((i) => ({ productId: i.productId, variantSku: i.variantSku, qty: i.qty })),
    `order ${order.id} cancelled`,
  );
  return getOrder(order.id);
}

module.exports = {
  ordersService: {
    cancelOrder,
    placeOrder,
    checkout,
    getOrder,
    getOrderForBuyer,
    listOrdersForBuyer,
    listSubOrdersForVendor,
  },
  transition,
};
