// Races against a real Postgres. The app pool allows 10 connections, so these
// requests really run in parallel.
process.env.NODE_ENV = 'test';

const postgres = require('../../src/db/postgres');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../../src/modules/ledger');
const { uniqueRef, makeWallet } = require('../helpers/ledger');

afterAll(() => postgres.close());

const transfer = (from, to, amountKobo, type = TRANSACTION_TYPES.ESCROW_HOLD) =>
  LedgerService.post({
    reference: uniqueRef('RACE'),
    type,
    entries: [
      { accountId: from, direction: 'debit', amountKobo },
      { accountId: to, direction: 'credit', amountKobo },
    ],
  });

test('10 parallel debits against a balance that covers 5: exactly 5 succeed', async () => {
  const wallet = await makeWallet({ balance: 500 });
  const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => transfer(wallet.id, escrow.id, 100)),
  );

  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  expect(ok).toHaveLength(5);
  expect(refused.map((r) => r.reason.code)).toEqual(Array(5).fill('INSUFFICIENT_FUNDS'));
  expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(0);
});

test('opposite-direction transfers between two wallets never deadlock', async () => {
  const a = await makeWallet({ balance: 10000 });
  const b = await makeWallet({ balance: 10000 });

  // A→B and B→A at the same time. Without ascending-id lock order, these
  // would lock the two rows in opposite orders and Postgres would kill one.
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? transfer(a.id, b.id, 100 + i, TRANSACTION_TYPES.REFUND)
        : transfer(b.id, a.id, 100 + i, TRANSACTION_TYPES.REFUND),
    ),
  );

  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason.code);
  expect(failures).toEqual([]);

  const [after1, after2] = await Promise.all([
    LedgerService.getAccount(a.id),
    LedgerService.getAccount(b.id),
  ]);
  expect(after1.balanceKobo + after2.balanceKobo).toBe(20000);
  // Even indexes moved A→B (sum 100+102+...+118), odd ones B→A (101+...+119).
  expect(after1.balanceKobo).toBe(10000 - 1090 + 1100);
});

test('the ledger still audits clean after the races', async () => {
  const report = await LedgerService.audit();
  expect(report.ok).toBe(true);
});
