const { db, withTransaction } = require('../../db/postgres');
const { badRequest, conflict, notFound } = require('../../shared/errors');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { objectId } = require('../../shared/http/schemas');
const { logger } = require('../../shared/logger');
const { LedgerService, SYSTEM_ACCOUNTS } = require('../ledger');
const { usersRepository } = require('../users/users.repository');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { settingsRepository } = require('../settings/settings.repository');
const { settingsService } = require('../settings/settings.service');
const { reportsRepository, TZ } = require('./reports.repository');

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Users ---

async function listUsers({ q, role, status, limit, cursor }) {
  const after = decodeCursor(cursor);
  if (after && !objectId.safeParse(after.id).success) throw badRequest('Invalid cursor');
  const rows = await usersRepository.search({
    q,
    role,
    status,
    beforeId: after?.id,
    limit: limit + 1,
  });
  return paginate(rows, limit, (u) => ({ id: String(u._id) }));
}

/**
 * Freeze or unfreeze a user: MongoDB status (checkout and payouts refuse a
 * FROZEN user) and the Postgres wallet status (the ledger refuses debits from
 * a FROZEN account). Two databases, so it is safe to repeat: calling it again
 * finishes a change that failed half-way.
 */
async function setFrozen(admin, userId, { frozen, reason }) {
  if (userId === admin.id)
    throw conflict('CANNOT_FREEZE_SELF', 'You cannot freeze your own account');
  const user = await usersRepository.setFrozen(userId, { frozen, by: admin.id, reason });
  if (!user) throw notFound('User');
  const wallet = await LedgerService.setUserAccountStatus(userId, frozen ? 'FROZEN' : 'ACTIVE');
  logger.info({ userId, frozen, by: admin.id, reason }, frozen ? 'User frozen' : 'User unfrozen');
  return { user, walletStatus: wallet?.status ?? null };
}

// --- Wallets and transactions ---

/** Any wallet (user or system account) and its full ledger history, newest first. */
async function walletLedger(accountId, { limit, cursor }) {
  const account = await LedgerService.getAccount(accountId);
  const after = decodeCursor(cursor);
  if (after && !Number.isSafeInteger(after.id)) throw badRequest('Invalid cursor');
  const rows = await LedgerService.listEntries(account.id, {
    beforeId: after?.id,
    limit: limit + 1,
  });
  return { account, ...paginate(rows, limit, (e) => ({ id: e.id })) };
}

async function listTransactions({ type, reference, limit, cursor }) {
  const after = decodeCursor(cursor);
  if (after && (!PG_TIMESTAMP.test(String(after.t)) || !UUID.test(String(after.id)))) {
    throw badRequest('Invalid cursor');
  }
  const rows = await LedgerService.listTransactions({ type, reference, after, limit: limit + 1 });
  const page = paginate(rows, limit, (t) => ({ t: t.cursorTime, id: t.id }));
  return {
    items: page.items.map(({ cursorTime: _t, ...rest }) => rest),
    nextCursor: page.nextCursor,
  };
}

// --- Settings ---

const getSettings = () => settingsService.getBusinessSettings();

/**
 * New commission rate for future checkouts. Each sub-order keeps the rate
 * snapshotted when it was bought, so existing orders are not affected.
 */
async function setCommission(admin, { commissionBps }) {
  await settingsRepository.set(db, 'commission_bps', commissionBps, admin.id);
  logger.info({ commissionBps, by: admin.id }, 'Commission rate changed');
  return settingsService.getBusinessSettings();
}

// --- Reports ---

async function revenueReport({ from, to }) {
  const revenue = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_REVENUE);
  const days = await reportsRepository.revenueByDay(db, { revenueAccountId: revenue.id, from, to });
  return {
    from,
    to,
    timezone: TZ,
    totalKobo: days.reduce((sum, d) => sum + d.revenueKobo, 0),
    days,
  };
}

async function topVendorsReport() {
  const rows = await reportsRepository.topVendorsThisMonth(db, { limit: 10 });
  const stores = await vendorsRepository.findByIds(rows.map((r) => r.vendorId));
  const byId = new Map(stores.map((v) => [String(v._id), v]));
  return {
    timezone: TZ,
    vendors: rows.map((r, i) => ({
      rank: i + 1,
      ...r,
      storeName: byId.get(r.vendorId)?.storeName ?? null,
    })),
  };
}

/**
 * Money held in escrow now (the PLATFORM_ESCROW balance), next to the
 * unfinished sub-orders that should account for it.
 */
async function escrowReport() {
  return withTransaction(async (trx) => {
    // One snapshot so the two figures are read at the same moment.
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW, trx);
    const byStatus = await reportsRepository.openSubOrdersByStatus(trx);
    const openTotal = byStatus.reduce((sum, s) => sum + s.totalKobo, 0);
    return {
      escrowBalanceKobo: escrow.balanceKobo,
      openSubOrders: { totalKobo: openTotal, byStatus },
      matches: escrow.balanceKobo === openTotal,
    };
  });
}

async function reconciliationReport() {
  const mismatches = await LedgerService.reconciliation();
  return { ok: mismatches.length === 0, mismatches };
}

module.exports = {
  adminService: {
    listUsers,
    setFrozen,
    walletLedger,
    listTransactions,
    getSettings,
    setCommission,
    revenueReport,
    topVendorsReport,
    escrowReport,
    reconciliationReport,
  },
};
