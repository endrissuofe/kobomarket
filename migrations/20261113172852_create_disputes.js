// Disputes on a sub-order. An OPEN dispute freezes the sub-order's escrow
// (the sub-order is DISPUTED, which auto-complete never touches) until an
// admin resolves it: full refund, partial refund, or rejected.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE disputes (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sub_order_id        UUID NOT NULL REFERENCES sub_orders(id),
      buyer_id            TEXT NOT NULL,
      reason              TEXT NOT NULL,
      evidence            JSONB NOT NULL DEFAULT '[]'::jsonb,
      vendor_response     TEXT,
      vendor_evidence     JSONB NOT NULL DEFAULT '[]'::jsonb,
      vendor_responded_at TIMESTAMPTZ,
      status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
      resolution          TEXT CHECK (resolution IN ('FULL_REFUND', 'PARTIAL_REFUND', 'REJECTED')),
      refund_kobo         BIGINT CHECK (refund_kobo >= 0),
      resolved_by         TEXT,
      note                TEXT,
      resolution_txn_id   UUID REFERENCES transactions(id),
      resolved_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Every resolution records who, how, why and the money movement.
      CONSTRAINT disputes_resolved_complete CHECK (
        status = 'OPEN' OR (
          resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
          AND note IS NOT NULL AND length(trim(note)) > 0
          AND resolution_txn_id IS NOT NULL AND refund_kobo IS NOT NULL
        )
      ),
      CONSTRAINT disputes_refund_matches_resolution CHECK (
        resolution IS NULL
        OR (resolution = 'REJECTED' AND refund_kobo = 0)
        OR (resolution IN ('FULL_REFUND', 'PARTIAL_REFUND') AND refund_kobo > 0)
      )
    )
  `);
  // At most one open dispute per sub-order.
  await knex.raw(`
    CREATE UNIQUE INDEX disputes_one_open_per_sub_order
    ON disputes (sub_order_id) WHERE status = 'OPEN'
  `);
  await knex.raw(
    'CREATE INDEX disputes_status_created_idx ON disputes (status, created_at DESC, id DESC)',
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS disputes');
};
