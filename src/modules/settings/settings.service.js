const { db } = require('../../db/postgres');
const config = require('../../config');
const { settingsRepository } = require('./settings.repository');

/**
 * Live business settings. The settings table (admin-editable) wins; the
 * environment defaults fill anything missing. Pass a transaction to read
 * inside it (checkout snapshots commission this way).
 */
async function getBusinessSettings(trx) {
  const stored = await settingsRepository.getAll(trx || db);
  const pick = (key, fallback) => (Number.isSafeInteger(stored[key]) ? stored[key] : fallback);
  return {
    commissionBps: pick('commission_bps', config.business.commissionBps),
    escrowTimeoutHours: pick('escrow_timeout_hours', config.business.escrowTimeoutHours),
    payoutMinKobo: pick('payout_min_kobo', config.business.payoutMinKobo),
  };
}

module.exports = { settingsService: { getBusinessSettings } };
