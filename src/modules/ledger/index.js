// Wires the ledger module to the app's Postgres pool.
// Usage: const { LedgerService } = require('../ledger');
//        await LedgerService.post({ reference, type, entries }, trx);

const { db } = require('../../db/postgres');
const { createLedgerRepository } = require('./ledger.repository');
const { createLedgerService } = require('./ledger.service');
const constants = require('./ledger.constants');

const LedgerService = createLedgerService({ db, repository: createLedgerRepository() });

module.exports = { LedgerService, createLedgerService, createLedgerRepository, ...constants };
