const { db, withTransaction } = require('../../db/postgres');
const { badRequest, conflict, notFound, validationError } = require('../../shared/errors');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { splitByBps } = require('../../shared/money/kobo');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../ledger');
const { ordersRepository } = require('../orders/orders.repository');
const { transition, releaseEscrow } = require('../orders/orders.service');
const { SUB_ORDER_STATUS: S } = require('../orders/state-machine');
const { approvedStoreOf } = require('../products/products.service');
const { outboxRepository, OUTBOX_EVENTS } = require('../outbox/outbox.repository');
const { disputesRepository } = require('./disputes.repository');
const { DISPUTE_STATUS, RESOLUTIONS } = require('./disputes.constants');

const DISPUTABLE = [S.SHIPPED, S.DELIVERED];
const withoutCursor = ({ cursorTime: _t, ...rest }) => rest;

/**
 * Buyer opens a dispute on a shipped sub-order. It moves to DISPUTED, which
 * freezes its escrow: auto-complete only ever completes SHIPPED sub-orders.
 */
async function open(buyer, subOrderId, { reason, evidence }) {
  const dispute = await withTransaction(async (trx) => {
    const sub = await ordersRepository.lockSubOrder(trx, subOrderId);
    const order = sub && (await ordersRepository.findOrder(trx, sub.orderId));
    if (!order || order.buyerId !== buyer.id) throw notFound('Sub-order');
    if (sub.status === S.DISPUTED) {
      throw conflict('DISPUTE_ALREADY_OPEN', 'This sub-order already has an open dispute');
    }
    if (!DISPUTABLE.includes(sub.status)) {
      throw conflict(
        'NOT_DISPUTABLE',
        sub.status === S.PAID
          ? 'This has not shipped yet; cancel the order instead'
          : `A ${sub.status} sub-order cannot be disputed`,
        { status: sub.status },
      );
    }

    await transition(trx, sub, S.DISPUTED, { actorId: buyer.id, reason: 'buyer opened a dispute' });
    const created = await disputesRepository.insert(trx, {
      subOrderId: sub.id,
      buyerId: buyer.id,
      reason,
      evidence,
    });
    await outboxRepository.add(trx, {
      aggregate: 'dispute',
      aggregateId: created.id,
      eventType: OUTBOX_EVENTS.DISPUTE_OPENED,
      payload: {
        disputeId: created.id,
        subOrderId: sub.id,
        buyerId: buyer.id,
        vendorUserId: sub.vendorUserId,
      },
    });
    return created;
  });
  return withoutCursor(await disputesRepository.find(db, dispute.id));
}

/** The vendor of the disputed sub-order replies once, with their own evidence. */
async function respond(vendorUser, disputeId, { response, evidence }) {
  const store = await approvedStoreOf(vendorUser);
  const dispute = await disputesRepository.find(db, disputeId);
  if (!dispute || dispute.vendorId !== String(store._id)) throw notFound('Dispute');
  if (dispute.status !== DISPUTE_STATUS.OPEN) {
    throw conflict('DISPUTE_ALREADY_RESOLVED', 'This dispute has already been resolved');
  }
  const saved = await disputesRepository.saveVendorResponse(db, disputeId, { response, evidence });
  if (!saved) throw conflict('ALREADY_RESPONDED', 'You have already replied to this dispute');
  return withoutCursor(await disputesRepository.find(db, disputeId));
}

// --- Resolution ---

/** Escrow -> buyer for the whole sub-order. DISPUTED -> REFUNDED. */
async function fullRefund(trx, { dispute, sub, order, admin, note }) {
  const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW, trx);
  const { transaction } = await LedgerService.post(
    {
      reference: `DSP-${dispute.id}`,
      type: TRANSACTION_TYPES.REFUND,
      entries: [
        { accountId: escrow.id, direction: 'debit', amountKobo: sub.subtotalKobo },
        { accountId: order.buyerAccountId, direction: 'credit', amountKobo: sub.subtotalKobo },
      ],
      metadata: { disputeId: dispute.id, subOrderId: sub.id, resolution: RESOLUTIONS.FULL_REFUND },
    },
    trx,
  );
  await transition(trx, sub, S.REFUNDED, {
    actorId: admin.id,
    reason: `dispute resolved: full refund. ${note}`,
    fields: { refund_txn_id: transaction.id },
  });
  return { txnId: transaction.id, refundKobo: sub.subtotalKobo };
}

/**
 * Part back to the buyer, the rest to the vendor minus commission on that
 * rest only, all in one balanced REFUND posting. DISPUTED -> COMPLETED.
 */
async function partialRefund(trx, { dispute, sub, order, admin, note, refundKobo }) {
  if (refundKobo >= sub.subtotalKobo) {
    throw validationError({
      refundKobo: [
        `Must be less than the sub-order total (${sub.subtotalKobo} kobo); use FULL_REFUND`,
      ],
    });
  }
  const rest = sub.subtotalKobo - refundKobo;
  const { commission, net } = splitByBps(rest, sub.commissionBps);
  const [escrow, revenue, vendorAccount] = await Promise.all([
    LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW, trx),
    LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_REVENUE, trx),
    LedgerService.openUserAccount(sub.vendorUserId, trx),
  ]);
  const entries = [
    { accountId: escrow.id, direction: 'debit', amountKobo: sub.subtotalKobo },
    { accountId: order.buyerAccountId, direction: 'credit', amountKobo: refundKobo },
  ];
  if (net > 0) entries.push({ accountId: vendorAccount.id, direction: 'credit', amountKobo: net });
  if (commission > 0) {
    entries.push({ accountId: revenue.id, direction: 'credit', amountKobo: commission });
  }
  const { transaction } = await LedgerService.post(
    {
      reference: `DSP-${dispute.id}`,
      type: TRANSACTION_TYPES.REFUND,
      entries,
      metadata: {
        disputeId: dispute.id,
        subOrderId: sub.id,
        resolution: RESOLUTIONS.PARTIAL_REFUND,
        refundKobo,
        vendorNetKobo: net,
        commissionKobo: commission,
        commissionBps: sub.commissionBps,
      },
    },
    trx,
  );
  await transition(trx, sub, S.COMPLETED, {
    actorId: admin.id,
    reason: `dispute resolved: partial refund of ${refundKobo} kobo. ${note}`,
    fields: {
      completed_at: trx.fn.now(),
      release_txn_id: transaction.id,
      refund_txn_id: transaction.id,
    },
  });
  return { txnId: transaction.id, refundKobo };
}

/** Reject: release escrow to the vendor exactly as a normal completion. */
async function reject(trx, { sub, admin, note }) {
  const completed = await releaseEscrow(trx, sub, {
    actorId: admin.id,
    reason: `dispute resolved: rejected. ${note}`,
  });
  return { txnId: completed.releaseTxnId, refundKobo: 0 };
}

const RESOLVERS = {
  [RESOLUTIONS.FULL_REFUND]: fullRefund,
  [RESOLUTIONS.PARTIAL_REFUND]: partialRefund,
  [RESOLUTIONS.REJECTED]: reject,
};

/**
 * Admin resolves an open dispute. One transaction: lock the dispute, then the
 * sub-order, then (inside the ledger) the accounts; move the money; record
 * the admin, the note and the transaction. Resolving twice is a 409.
 */
async function resolve(admin, disputeId, { resolution, refundKobo, note }) {
  await withTransaction(async (trx) => {
    const dispute = await disputesRepository.lock(trx, disputeId);
    if (!dispute) throw notFound('Dispute');
    if (dispute.status !== DISPUTE_STATUS.OPEN) {
      throw conflict('DISPUTE_ALREADY_RESOLVED', 'This dispute has already been resolved', {
        resolution: dispute.resolution,
      });
    }
    const sub = await ordersRepository.lockSubOrder(trx, dispute.subOrderId);
    const order = await ordersRepository.findOrder(trx, sub.orderId);

    const outcome = await RESOLVERS[resolution](trx, {
      dispute,
      sub,
      order,
      admin,
      note,
      refundKobo,
    });
    await disputesRepository.resolve(trx, dispute.id, {
      resolution,
      refundKobo: outcome.refundKobo,
      resolvedBy: admin.id,
      note,
      txnId: outcome.txnId,
    });
    await outboxRepository.add(trx, {
      aggregate: 'dispute',
      aggregateId: dispute.id,
      eventType: OUTBOX_EVENTS.DISPUTE_RESOLVED,
      payload: {
        disputeId: dispute.id,
        subOrderId: sub.id,
        resolution,
        refundKobo: outcome.refundKobo,
        buyerId: dispute.buyerId,
        vendorUserId: sub.vendorUserId,
      },
    });
  });
  return withoutCursor(await disputesRepository.find(db, disputeId));
}

// --- Reads ---

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readCursor(raw) {
  const c = decodeCursor(raw);
  if (c && (!PG_TIMESTAMP.test(String(c.t)) || !UUID.test(String(c.id)))) {
    throw badRequest('Invalid cursor');
  }
  return c;
}

async function listPage({ status, participantId, limit, cursor }) {
  const rows = await disputesRepository.list(db, {
    status,
    participantId,
    after: readCursor(cursor),
    limit: limit + 1,
  });
  const page = paginate(rows, limit, (d) => ({ t: d.cursorTime, id: d.id }));
  return { items: page.items.map(withoutCursor), nextCursor: page.nextCursor };
}

/** Admin: every dispute, optionally by status. */
const listAll = (query) => listPage(query);

/** Disputes where the user is the buyer or the vendor. */
const listMine = (user, query) => listPage({ ...query, participantId: user.id });

/** Admin: one dispute with both sides' evidence. */
async function get(disputeId) {
  const dispute = await disputesRepository.find(db, disputeId);
  if (!dispute) throw notFound('Dispute');
  return withoutCursor(dispute);
}

module.exports = { disputesService: { open, respond, resolve, listAll, listMine, get } };
