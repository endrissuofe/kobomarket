const { FUNDING_STATUS } = require('./wallet.constants');

function toFunding(row) {
  return (
    row && {
      id: row.id,
      userId: row.user_id,
      accountId: row.account_id,
      provider: row.provider,
      reference: row.reference,
      amountKobo: row.amount_kobo,
      currency: row.currency,
      status: row.status,
      authorizationUrl: row.authorization_url,
      transactionId: row.transaction_id,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }
  );
}

// The only code that touches wallet_fundings. Functions take the knex instance
// or a transaction so the service decides the boundary.
const walletRepository = {
  async createFunding(conn, { userId, accountId, provider, reference, amountKobo }) {
    const [row] = await conn('wallet_fundings')
      .insert({
        user_id: userId,
        account_id: accountId,
        provider,
        reference,
        amount_kobo: amountKobo,
      })
      .returning('*');
    return toFunding(row);
  },

  async setAuthorizationUrl(conn, id, authorizationUrl) {
    await conn('wallet_fundings').where({ id }).update({ authorization_url: authorizationUrl });
  },

  async findByReference(conn, reference) {
    return toFunding(await conn('wallet_fundings').where({ reference }).first());
  },

  /** Lock the funding row for the rest of the transaction. */
  async lockById(trx, id) {
    return toFunding(await trx('wallet_fundings').where({ id }).forUpdate().first());
  },

  async markSuccess(trx, id, transactionId) {
    await trx('wallet_fundings').where({ id, status: FUNDING_STATUS.INITIATED }).update({
      status: FUNDING_STATUS.SUCCESS,
      transaction_id: transactionId,
      completed_at: trx.fn.now(),
    });
  },

  /** Only an INITIATED funding can fail; a SUCCESS is final. */
  async markFailed(conn, id, reason) {
    await conn('wallet_fundings').where({ id, status: FUNDING_STATUS.INITIATED }).update({
      status: FUNDING_STATUS.FAILED,
      failure_reason: reason,
      completed_at: conn.fn.now(),
    });
  },
};

module.exports = { walletRepository, toFunding };
