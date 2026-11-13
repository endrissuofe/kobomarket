// The only code that touches orders, sub_orders, order_items and
// order_status_history. Every function takes the knex instance or a
// transaction, so the service owns the transaction boundary.

function toSubOrder(row) {
  return (
    row && {
      id: row.id,
      orderId: row.order_id,
      vendorId: row.vendor_id,
      vendorUserId: row.vendor_user_id,
      status: row.status,
      subtotalKobo: row.subtotal_kobo,
      commissionBps: row.commission_bps,
      courierName: row.courier_name,
      trackingNumber: row.tracking_number,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
      autoCompleteAt: row.auto_complete_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      releaseTxnId: row.release_txn_id,
      refundTxnId: row.refund_txn_id,
      createdAt: row.created_at,
    }
  );
}

function toOrder(row) {
  return (
    row && {
      id: row.id,
      buyerId: row.buyer_id,
      buyerAccountId: row.buyer_account_id,
      totalKobo: row.total_kobo,
      currency: row.currency,
      escrowTxnId: row.escrow_txn_id,
      createdAt: row.created_at,
    }
  );
}

function toItem(row) {
  return {
    id: row.id,
    subOrderId: row.sub_order_id,
    productId: row.product_id,
    variantSku: row.variant_sku,
    name: row.name_snapshot,
    unitPriceKobo: row.unit_price_kobo,
    qty: row.qty,
    lineTotalKobo: row.line_total_kobo,
  };
}

const ordersRepository = {
  async insertOrder(trx, { id, buyerId, buyerAccountId, totalKobo, idempotencyKey, escrowTxnId }) {
    const [row] = await trx('orders')
      .insert({
        id,
        escrow_txn_id: escrowTxnId,
        buyer_id: buyerId,
        buyer_account_id: buyerAccountId,
        total_kobo: totalKobo,
        idempotency_key: idempotencyKey ?? null,
      })
      .returning('*');
    return toOrder(row);
  },

  async insertSubOrder(trx, { orderId, vendorId, vendorUserId, subtotalKobo, commissionBps }) {
    const [row] = await trx('sub_orders')
      .insert({
        order_id: orderId,
        vendor_id: vendorId,
        vendor_user_id: vendorUserId,
        subtotal_kobo: subtotalKobo,
        commission_bps: commissionBps,
      })
      .returning('*');
    return toSubOrder(row);
  },

  async insertItems(trx, subOrderId, items) {
    await trx('order_items').insert(
      items.map((i) => ({
        sub_order_id: subOrderId,
        product_id: i.productId,
        variant_sku: i.variantSku ?? null,
        name_snapshot: i.name,
        unit_price_kobo: i.unitPriceKobo,
        qty: i.qty,
      })),
    );
  },

  async addHistory(trx, { subOrderId, from, to, actorId, reason }) {
    await trx('order_status_history').insert({
      sub_order_id: subOrderId,
      from_status: from ?? null,
      to_status: to,
      actor_id: String(actorId),
      reason: reason ?? null,
    });
  },

  /** Lock one sub-order for the rest of the transaction. */
  async lockSubOrder(trx, id) {
    return toSubOrder(await trx('sub_orders').where({ id }).forUpdate().first());
  },

  /** Lock all sub-orders of an order, in id order (consistent lock order). */
  async lockSubOrdersOfOrder(trx, orderId) {
    const rows = await trx('sub_orders').where({ order_id: orderId }).orderBy('id').forUpdate();
    return rows.map(toSubOrder);
  },

  /** Set status plus any timestamp/txn columns given (snake_case). */
  async updateSubOrder(trx, id, fields) {
    const [row] = await trx('sub_orders').where({ id }).update(fields).returning('*');
    return toSubOrder(row);
  },

  async findOrder(conn, id) {
    return toOrder(await conn('orders').where({ id }).first());
  },

  async findSubOrder(conn, id) {
    return toSubOrder(await conn('sub_orders').where({ id }).first());
  },

  async findSubOrdersWithItems(conn, orderIds) {
    if (orderIds.length === 0) return [];
    const subs = (await conn('sub_orders').whereIn('order_id', orderIds).orderBy('created_at')).map(
      toSubOrder,
    );
    const items = subs.length
      ? (
          await conn('order_items')
            .whereIn(
              'sub_order_id',
              subs.map((s) => s.id),
            )
            .orderBy('id')
        ).map(toItem)
      : [];
    return subs.map((s) => ({ ...s, items: items.filter((i) => i.subOrderId === s.id) }));
  },

  /**
   * Buyer's orders, newest first, keyset on (created_at, id). The cursor
   * carries created_at as Postgres text: a JS Date would drop the
   * microseconds and rows could repeat or be skipped.
   */
  async listOrdersForBuyer(conn, buyerId, { after, limit }) {
    const query = conn('orders')
      .where({ buyer_id: buyerId })
      .select('*', conn.raw('created_at::text AS created_at_text'))
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    if (after) {
      query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
    }
    return (await query).map((row) => ({ ...toOrder(row), cursorTime: row.created_at_text }));
  },

  /** A vendor's sub-orders, newest first, optionally by status; same keyset. */
  async listSubOrdersForVendor(conn, vendorId, { status, after, limit }) {
    const query = conn('sub_orders')
      .where({ vendor_id: vendorId })
      .select('*', conn.raw('created_at::text AS created_at_text'))
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    if (status) query.where({ status });
    if (after) {
      query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
    }
    const subs = (await query).map((row) => ({
      ...toSubOrder(row),
      cursorTime: row.created_at_text,
    }));
    if (subs.length === 0) return [];
    const items = (
      await conn('order_items')
        .whereIn(
          'sub_order_id',
          subs.map((x) => x.id),
        )
        .orderBy('id')
    ).map(toItem);
    return subs.map((x) => ({ ...x, items: items.filter((i) => i.subOrderId === x.id) }));
  },

  async historyOf(conn, subOrderId) {
    return conn('order_status_history').where({ sub_order_id: subOrderId }).orderBy('id');
  },
};

module.exports = { ordersRepository, toSubOrder, toOrder };
