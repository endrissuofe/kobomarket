// Orders and escrow.
//
// One checkout = one order (the buyer's payment, one ESCROW_HOLD) split into
// one sub-order per vendor. Sub-orders carry the state machine; the order's
// status is derived from them, never stored, so the two cannot disagree.
// order_items snapshot name and price in kobo at checkout: the Mongo price
// may change later, what the buyer paid may not.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE orders (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      buyer_id           TEXT NOT NULL,
      buyer_account_id   UUID NOT NULL REFERENCES accounts(id),
      total_kobo         BIGINT NOT NULL CHECK (total_kobo > 0),
      currency           TEXT NOT NULL DEFAULT 'NGN',
      idempotency_key    TEXT,
      escrow_txn_id      UUID REFERENCES transactions(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Backstop behind the Idempotency-Key middleware: one order per key per buyer.
      UNIQUE (buyer_id, idempotency_key)
    )
  `);
  await knex.raw(
    'CREATE INDEX orders_buyer_created_idx ON orders (buyer_id, created_at DESC, id DESC)',
  );

  await knex.raw(`
    CREATE TABLE sub_orders (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id          UUID NOT NULL REFERENCES orders(id),
      vendor_id         TEXT NOT NULL,          -- Mongo vendors._id
      vendor_user_id    TEXT NOT NULL,          -- Mongo users._id: owns the vendor wallet
      status            TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN (
                          'PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED',
                          'CANCELLED', 'DISPUTED', 'REFUNDED')),
      subtotal_kobo     BIGINT NOT NULL CHECK (subtotal_kobo > 0),
      -- Commission rate at checkout; a later admin change does not touch it.
      commission_bps    INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
      courier_name      TEXT,
      tracking_number   TEXT,
      shipped_at        TIMESTAMPTZ,
      delivered_at      TIMESTAMPTZ,
      auto_complete_at  TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      release_txn_id    UUID REFERENCES transactions(id),
      refund_txn_id     UUID REFERENCES transactions(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT sub_orders_shipped_has_tracking
        CHECK (shipped_at IS NULL OR (courier_name IS NOT NULL AND tracking_number IS NOT NULL)),
      CONSTRAINT sub_orders_completed_has_release
        CHECK (status <> 'COMPLETED' OR release_txn_id IS NOT NULL)
    )
  `);
  await knex.raw('CREATE INDEX sub_orders_order_idx ON sub_orders (order_id)');
  await knex.raw(
    'CREATE INDEX sub_orders_vendor_created_idx ON sub_orders (vendor_id, created_at DESC, id DESC)',
  );
  // The auto-complete job scans only shipped sub-orders that are due.
  await knex.raw(`
    CREATE INDEX sub_orders_auto_complete_idx ON sub_orders (auto_complete_at)
    WHERE status = 'SHIPPED'
  `);

  await knex.raw(`
    CREATE TABLE order_items (
      id                BIGSERIAL PRIMARY KEY,
      sub_order_id      UUID NOT NULL REFERENCES sub_orders(id),
      product_id        TEXT NOT NULL,          -- Mongo products._id
      variant_sku       TEXT,
      name_snapshot     TEXT NOT NULL,
      unit_price_kobo   BIGINT NOT NULL CHECK (unit_price_kobo > 0),
      qty               INTEGER NOT NULL CHECK (qty > 0),
      line_total_kobo   BIGINT GENERATED ALWAYS AS (unit_price_kobo * qty) STORED
    )
  `);
  await knex.raw('CREATE INDEX order_items_sub_order_idx ON order_items (sub_order_id)');

  // Audit trail of every status change. Append-only, like the ledger.
  await knex.raw(`
    CREATE TABLE order_status_history (
      id            BIGSERIAL PRIMARY KEY,
      sub_order_id  UUID NOT NULL REFERENCES sub_orders(id),
      from_status   TEXT,
      to_status     TEXT NOT NULL,
      actor_id      TEXT NOT NULL,          -- user id, or 'system' for jobs
      reason        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(
    'CREATE INDEX order_status_history_sub_order_idx ON order_status_history (sub_order_id, id)',
  );
  // Same refusal function as the ledger tables.
  await knex.raw(`
    CREATE TRIGGER order_status_history_no_update_delete
    BEFORE UPDATE OR DELETE ON order_status_history
    FOR EACH ROW EXECUTE FUNCTION ledger_refuse_change()
  `);
  await knex.raw(`
    CREATE TRIGGER order_status_history_no_truncate
    BEFORE TRUNCATE ON order_status_history
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_refuse_change()
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS order_status_history');
  await knex.raw('DROP TABLE IF EXISTS order_items');
  await knex.raw('DROP TABLE IF EXISTS sub_orders');
  await knex.raw('DROP TABLE IF EXISTS orders');
};
