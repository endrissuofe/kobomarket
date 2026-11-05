// npm run audit:ledger
// Checks that money is conserved. Prints PASS or FAIL per check and exits 1 on FAIL.
//
// 1. The whole ledger nets to zero (SUM(credits) - SUM(debits) = 0).
// 2. Every account's cached balance_kobo equals its ledger sum.
// 3. Every transaction has 2+ entries that net to zero.
// 4. No account is below zero except EXTERNAL_PAYSTACK.

const postgres = require('../src/db/postgres');
const { LedgerService } = require('../src/modules/ledger');
const { formatNaira } = require('../src/shared/money/kobo');

const LABELS = {
  ledgerNetsToZero: 'Whole ledger nets to zero',
  cachedBalancesMatchLedger: 'Cached balances match the ledger',
  transactionsBalanced: 'Every transaction balances',
  noUnexpectedNegativeBalances: 'No unexpected negative balances',
};

async function main() {
  const report = await LedgerService.audit();

  for (const [name, check] of Object.entries(report.checks)) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${LABELS[name] || name}`);
    if (name === 'ledgerNetsToZero' && !check.ok) {
      console.log(`      net is ${formatNaira(check.netKobo)} (${check.netKobo} kobo)`);
    }
    for (const problem of (check.problems || []).slice(0, 20)) {
      console.log('      ', JSON.stringify(problem));
    }
    if (check.problems && check.problems.length > 20) {
      console.log(`       ...and ${check.problems.length - 20} more`);
    }
  }

  console.log(report.ok ? '\naudit:ledger PASS' : '\naudit:ledger FAIL');
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('audit:ledger could not run:', err.message);
    process.exitCode = 2;
  })
  .finally(() => postgres.close());
