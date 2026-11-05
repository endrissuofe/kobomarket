// System accounts the money flows need. They live in a migration, not in
// seeds/, because the app cannot run without them in any environment.
// Names are copied here on purpose: migrations must not depend on app code
// that may change later.
//
// PLATFORM_ESCROW           buyer money held for open sub-orders
// PLATFORM_REVENUE          commission earned
// PLATFORM_PAYOUT_CLEARING  vendor money on its way to the bank
// EXTERNAL_PAYSTACK         counterparty for funding and payouts; the only
//                           account expected to go negative

const SYSTEM_ACCOUNTS = [
  'PLATFORM_ESCROW',
  'PLATFORM_REVENUE',
  'PLATFORM_PAYOUT_CLEARING',
  'EXTERNAL_PAYSTACK',
];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex('accounts')
    .insert(SYSTEM_ACCOUNTS.map((ownerId) => ({ owner_type: 'SYSTEM', owner_id: ownerId })))
    .onConflict(['owner_type', 'owner_id', 'currency'])
    .ignore();
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  // Fails (FK) once any ledger entry points at these accounts, which is what we want.
  await knex('accounts').where({ owner_type: 'SYSTEM' }).whereIn('owner_id', SYSTEM_ACCOUNTS).del();
};
