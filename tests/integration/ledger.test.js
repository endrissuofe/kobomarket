// LedgerService.post() and the database guards, against a real Postgres.
process.env.NODE_ENV = 'test';

const postgres = require('../../src/db/postgres');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../../src/modules/ledger');
const { splitByBps } = require('../../src/shared/money/kobo');
const { uniqueRef, makeWallet, errorCode } = require('../helpers/ledger');

const { db } = postgres;

afterAll(() => postgres.close());

const debit = (accountId, amountKobo) => ({ accountId, direction: 'debit', amountKobo });
const credit = (accountId, amountKobo) => ({ accountId, direction: 'credit', amountKobo });
const system = (name) => LedgerService.getSystemAccount(name);
const transactionExists = async (reference) =>
  Boolean(await db('transactions').where({ reference }).first());

describe('system accounts', () => {
  test.each(Object.values(SYSTEM_ACCOUNTS))('%s exists', async (name) => {
    const account = await system(name);
    expect(account.ownerType).toBe('SYSTEM');
    expect(account.currency).toBe('NGN');
  });
});

describe('LedgerService.post', () => {
  test('funding credits the wallet and debits EXTERNAL_PAYSTACK', async () => {
    const wallet = await makeWallet();
    const paystack = await system(SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK);
    const reference = uniqueRef('FUND');

    const result = await LedgerService.post({
      reference,
      type: TRANSACTION_TYPES.FUNDING,
      entries: [debit(paystack.id, 1250000), credit(wallet.id, 1250000)],
      metadata: { provider: 'mock' },
    });

    expect(result.transaction).toMatchObject({ reference, type: 'FUNDING', status: 'POSTED' });
    expect(result.transaction.metadata).toEqual({ provider: 'mock' });
    expect(result.entries).toHaveLength(2);
    expect(result.balances[wallet.id]).toBe(1250000);
    expect(result.balances[paystack.id]).toBe(paystack.balanceKobo - 1250000);
    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(1250000);
  });

  test('escrow release splits net to vendor and commission to revenue, to the kobo', async () => {
    const buyer = await makeWallet({ balance: 333333 });
    const vendor = await makeWallet();
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const revenue = await system(SYSTEM_ACCOUNTS.PLATFORM_REVENUE);

    await LedgerService.post({
      reference: uniqueRef('HOLD'),
      type: TRANSACTION_TYPES.ESCROW_HOLD,
      entries: [debit(buyer.id, 333333), credit(escrow.id, 333333)],
    });

    const { commission, net } = splitByBps(333333, 500);
    const result = await LedgerService.post({
      reference: uniqueRef('RELEASE'),
      type: TRANSACTION_TYPES.ESCROW_RELEASE,
      entries: [debit(escrow.id, 333333), credit(vendor.id, net), credit(revenue.id, commission)],
    });

    expect(commission).toBe(16666);
    expect(result.balances[vendor.id]).toBe(316667);
    expect(result.balances[buyer.id]).toBeUndefined();
    expect((await LedgerService.getAccount(buyer.id)).balanceKobo).toBe(0);
  });

  test('refuses an unbalanced posting and writes nothing', async () => {
    const wallet = await makeWallet({ balance: 1000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const reference = uniqueRef('BAD');

    const code = await errorCode(
      LedgerService.post({
        reference,
        type: TRANSACTION_TYPES.ESCROW_HOLD,
        entries: [debit(wallet.id, 1000), credit(escrow.id, 999)],
      }),
    );

    expect(code).toBe('UNBALANCED_TRANSACTION');
    expect(await transactionExists(reference)).toBe(false);
    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(1000);
  });

  test('refuses an overdraft and leaves the balance unchanged', async () => {
    const wallet = await makeWallet({ balance: 5000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const reference = uniqueRef('OVERDRAFT');

    let error;
    try {
      await LedgerService.post({
        reference,
        type: TRANSACTION_TYPES.ESCROW_HOLD,
        entries: [debit(wallet.id, 5001), credit(escrow.id, 5001)],
      });
    } catch (err) {
      error = err;
    }

    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(error.details).toEqual({ accountId: wallet.id, balanceKobo: 5000, requiredKobo: 5001 });
    expect(await transactionExists(reference)).toBe(false);
    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(5000);
  });

  test('refuses debits from a frozen wallet but still accepts credits (refunds)', async () => {
    const wallet = await makeWallet({ balance: 5000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    // Test setup only: freezing will belong to the admin module.
    await db('accounts').where({ id: wallet.id }).update({ status: 'FROZEN' });

    const hold = LedgerService.post({
      reference: uniqueRef('HOLD'),
      type: TRANSACTION_TYPES.ESCROW_HOLD,
      entries: [debit(wallet.id, 100), credit(escrow.id, 100)],
    });
    expect(await errorCode(hold)).toBe('ACCOUNT_FROZEN');

    const buyerB = await makeWallet({ balance: 100 });
    await LedgerService.post({
      reference: uniqueRef('HOLD'),
      type: TRANSACTION_TYPES.ESCROW_HOLD,
      entries: [debit(buyerB.id, 100), credit(escrow.id, 100)],
    });
    const refund = await LedgerService.post({
      reference: uniqueRef('REFUND'),
      type: TRANSACTION_TYPES.REFUND,
      entries: [debit(escrow.id, 100), credit(wallet.id, 100)],
    });
    expect(refund.balances[wallet.id]).toBe(5100);
  });

  test('refuses a duplicate reference and keeps the caller transaction usable', async () => {
    const wallet = await makeWallet({ balance: 2000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const reference = uniqueRef('ORD');
    const posting = {
      reference,
      type: TRANSACTION_TYPES.ESCROW_HOLD,
      entries: [debit(wallet.id, 1000), credit(escrow.id, 1000)],
    };
    const first = await LedgerService.post(posting);

    await db.transaction(async (trx) => {
      let error;
      try {
        await LedgerService.post(posting, trx);
      } catch (err) {
        error = err;
      }
      expect(error.code).toBe('DUPLICATE_TRANSACTION');
      expect(error.status).toBe(409);
      expect(error.details.transactionId).toBe(first.transaction.id);
      // The refusal did not abort the surrounding Postgres transaction.
      await expect(trx.raw('select 1')).resolves.toBeDefined();
    });

    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(1000);
  });

  test('refuses a reused idempotency key even with a new reference', async () => {
    const wallet = await makeWallet({ balance: 2000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const idempotencyKey = uniqueRef('KEY');
    const entries = [debit(wallet.id, 500), credit(escrow.id, 500)];

    await LedgerService.post({
      reference: uniqueRef(),
      type: 'ESCROW_HOLD',
      entries,
      idempotencyKey,
    });
    const again = LedgerService.post({
      reference: uniqueRef(),
      type: 'ESCROW_HOLD',
      entries,
      idempotencyKey,
    });

    expect(await errorCode(again)).toBe('DUPLICATE_TRANSACTION');
    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(1500);
  });

  test("rolls back with the caller's transaction", async () => {
    const wallet = await makeWallet({ balance: 1000 });
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const reference = uniqueRef('ROLLBACK');

    await expect(
      db.transaction(async (trx) => {
        await LedgerService.post(
          {
            reference,
            type: TRANSACTION_TYPES.ESCROW_HOLD,
            entries: [debit(wallet.id, 1000), credit(escrow.id, 1000)],
          },
          trx,
        );
        throw new Error('stock reservation failed');
      }),
    ).rejects.toThrow('stock reservation failed');

    expect(await transactionExists(reference)).toBe(false);
    expect((await LedgerService.getAccount(wallet.id)).balanceKobo).toBe(1000);
  });

  test('refuses an unknown account', async () => {
    const escrow = await system(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    const code = await errorCode(
      LedgerService.post({
        reference: uniqueRef(),
        type: TRANSACTION_TYPES.REFUND,
        entries: [debit(escrow.id, 1), credit('00000000-0000-4000-8000-000000000000', 1)],
      }),
    );
    expect(code).toBe('NOT_FOUND');
  });
});

describe('database guards (bypassing LedgerService)', () => {
  let transactionId;
  let entryId;

  beforeAll(async () => {
    const wallet = await makeWallet({ balance: 700 });
    const [entry] = await db('ledger_entries').where({ account_id: wallet.id });
    transactionId = entry.transaction_id;
    entryId = entry.id;
  });

  const pgCode = async (sql, bindings = []) => {
    try {
      await db.transaction((trx) => trx.raw(sql, bindings));
      return 'NO_ERROR';
    } catch (err) {
      return err.code;
    }
  };

  test.each([
    ['UPDATE ledger_entries', 'UPDATE ledger_entries SET amount_kobo = 1 WHERE id = ?', 'entry'],
    ['DELETE ledger_entries', 'DELETE FROM ledger_entries WHERE id = ?', 'entry'],
    ['UPDATE transactions', "UPDATE transactions SET type = 'REFUND' WHERE id = ?", 'txn'],
    ['DELETE transactions', 'DELETE FROM transactions WHERE id = ?', 'txn'],
  ])('%s is refused', async (_label, sql, target) => {
    expect(await pgCode(sql, [target === 'entry' ? entryId : transactionId])).toBe('23001');
  });

  test.each(['ledger_entries', 'transactions'])('TRUNCATE %s is refused', async (table) => {
    expect(await pgCode(`TRUNCATE ${table} CASCADE`)).toBe('23001');
  });

  test('raw unbalanced entries are rejected at commit', async () => {
    const wallet = await makeWallet();
    const reference = uniqueRef('RAW');

    const code = await (async () => {
      try {
        await db.transaction(async (trx) => {
          const [txn] = await trx('transactions')
            .insert({ reference, type: 'FUNDING' })
            .returning('id');
          await trx('ledger_entries').insert({
            transaction_id: txn.id,
            account_id: wallet.id,
            direction: 'credit',
            amount_kobo: 100,
          });
        });
        return 'NO_ERROR';
      } catch (err) {
        return err.code;
      }
    })();

    expect(code).toBe('23514');
    expect(await transactionExists(reference)).toBe(false);
  });

  test('a user wallet cannot be pushed below zero even by raw SQL', async () => {
    const wallet = await makeWallet();
    expect(await pgCode('UPDATE accounts SET balance_kobo = -1 WHERE id = ?', [wallet.id])).toBe(
      '23514',
    );
  });
});

describe('audit', () => {
  test('the whole ledger nets to zero and every cached balance matches', async () => {
    const report = await LedgerService.audit();
    expect(report.checks.ledgerNetsToZero).toEqual({ ok: true, netKobo: 0 });
    expect(report.checks.cachedBalancesMatchLedger.problems).toEqual([]);
    expect(report.checks.transactionsBalanced.problems).toEqual([]);
    expect(report.checks.noUnexpectedNegativeBalances.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
