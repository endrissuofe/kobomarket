// Admin reports. Every figure is computed by PostgreSQL (GROUP BY, SUM,
// generate_series), never by looping in JavaScript. Days and months are in
// Lagos time.

const TZ = 'Africa/Lagos';
const SIGNED = "CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END";
const OPEN_STATUSES = ['PAID', 'SHIPPED', 'DELIVERED', 'DISPUTED'];

const reportsRepository = {
  /**
   * Platform revenue per day for [from, to] (YYYY-MM-DD, inclusive): the net
   * movement on PLATFORM_REVENUE each day. Days with no revenue appear as 0.
   */
  async revenueByDay(db, { revenueAccountId, from, to }) {
    const { rows } = await db.raw(
      `WITH days AS (
         SELECT d::date AS day
           FROM generate_series(?::date, ?::date, interval '1 day') AS d
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(${SIGNED}), 0)::bigint AS revenue_kobo,
              COUNT(e.id)::int AS entries
         FROM days
         LEFT JOIN ledger_entries e
           ON e.account_id = ?
          AND e.created_at >= (days.day::timestamp AT TIME ZONE '${TZ}')
          AND e.created_at <  ((days.day + 1)::timestamp AT TIME ZONE '${TZ}')
        GROUP BY days.day
        ORDER BY days.day`,
      [from, to, revenueAccountId],
    );
    return rows.map((r) => ({ day: r.day, revenueKobo: r.revenue_kobo, entries: r.entries }));
  },

  /**
   * Top 10 vendors by completed sales this calendar month: sub-orders
   * COMPLETED this month, net of any partial refund given in a dispute.
   */
  async topVendorsThisMonth(db, { limit = 10 } = {}) {
    const { rows } = await db.raw(
      `SELECT s.vendor_id,
              COUNT(*)::int AS completed_sub_orders,
              SUM(s.subtotal_kobo - COALESCE(d.refund_kobo, 0))::bigint AS sales_kobo
         FROM sub_orders s
         LEFT JOIN disputes d
           ON d.sub_order_id = s.id AND d.resolution = 'PARTIAL_REFUND'
        WHERE s.status = 'COMPLETED'
          AND s.completed_at >= (date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')
        GROUP BY s.vendor_id
        ORDER BY sales_kobo DESC, s.vendor_id
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      vendorId: r.vendor_id,
      completedSubOrders: r.completed_sub_orders,
      salesKobo: r.sales_kobo,
    }));
  },

  /** Unfinished sub-orders (money that should be in escrow), by status. */
  async openSubOrdersByStatus(db) {
    const { rows } = await db.raw(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(subtotal_kobo), 0)::bigint AS total_kobo
         FROM sub_orders
        WHERE status = ANY(?)
        GROUP BY status
        ORDER BY status`,
      [OPEN_STATUSES],
    );
    return rows.map((r) => ({ status: r.status, count: r.count, totalKobo: r.total_kobo }));
  },
};

module.exports = { reportsRepository, TZ };
