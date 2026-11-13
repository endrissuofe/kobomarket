const { db } = require('../../db/postgres');

// A stuck IN_PROGRESS key (the process died mid-request) may be taken over
// by a retry with the same body after this long.
const STALE_AFTER_SECONDS = 60;

const idempotencyRepository = {
  /**
   * Claim the key for this request. Inserts a new IN_PROGRESS row, or takes
   * over an expired row, or a stale IN_PROGRESS row with the same body.
   * One statement, so two concurrent requests cannot both claim it.
   * Returns true if this request now owns the key.
   */
  async claim({ key, userId, endpoint, requestHash }) {
    const { rows } = await db.raw(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key, user_id, endpoint) DO UPDATE
         SET request_hash = EXCLUDED.request_hash,
             status = 'IN_PROGRESS',
             response_code = NULL,
             response_body = NULL,
             locked_at = now(),
             created_at = now(),
             expires_at = now() + interval '24 hours'
         WHERE idempotency_keys.expires_at < now()
            OR (idempotency_keys.status = 'IN_PROGRESS'
                AND idempotency_keys.locked_at < now() - make_interval(secs => ?)
                AND idempotency_keys.request_hash = EXCLUDED.request_hash)
       RETURNING key`,
      [key, userId, endpoint, requestHash, STALE_AFTER_SECONDS],
    );
    return rows.length === 1;
  },

  find({ key, userId, endpoint }) {
    return db('idempotency_keys').where({ key, user_id: userId, endpoint }).first();
  },

  complete({ key, userId, endpoint, responseCode, responseBody }) {
    return db('idempotency_keys')
      .where({ key, user_id: userId, endpoint, status: 'IN_PROGRESS' })
      .update({
        status: 'COMPLETED',
        response_code: responseCode,
        response_body: JSON.stringify(responseBody ?? null),
      });
  },

  /** Free the key after a server error so the client can retry. */
  release({ key, userId, endpoint }) {
    return db('idempotency_keys')
      .where({ key, user_id: userId, endpoint, status: 'IN_PROGRESS' })
      .del();
  },
};

module.exports = { idempotencyRepository, STALE_AFTER_SECONDS };
