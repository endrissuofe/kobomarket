const { formatNaira } = require('../../shared/money/kobo');
const { OUTBOX_EVENTS: E } = require('../outbox/outbox.repository');
const { registerHandler } = require('../../jobs/event-handlers');
const { NOTIFICATION_TYPES: T } = require('./notification.model');
const { notificationsRepository } = require('./notifications.repository');

const short = (id) => String(id).slice(0, 8);

const RESOLUTION_TEXT = {
  FULL_REFUND: 'resolved with a full refund',
  PARTIAL_REFUND: 'resolved with a partial refund',
  REJECTED: 'resolved in the seller’s favour',
};

/**
 * The notifications an outbox event creates, as plain documents. Pure:
 * easy to test, and the same event always gives the same documents.
 */
function notificationsFor(event) {
  const p = event.payload ?? {};
  const make = (userId, type, title, body, data = {}) => ({
    userId,
    type,
    title,
    body,
    data,
    sourceEventId: String(event.outboxId),
  });

  switch (event.eventType) {
    case E.ORDER_PLACED:
      return [
        make(
          p.buyerId,
          T.ORDER_PLACED,
          'Order placed',
          `Your order ${short(p.orderId)} for ${formatNaira(p.totalKobo)} is paid and held in escrow.`,
          { orderId: p.orderId },
        ),
        ...p.subOrders.map((s) =>
          make(
            s.vendorUserId,
            T.NEW_ORDER,
            'New order',
            `You have a new order (${short(s.id)}). Ship it to get paid.`,
            { orderId: p.orderId, subOrderId: s.id },
          ),
        ),
      ];
    case E.ORDER_CANCELLED:
      return p.subOrders.map((s) =>
        make(
          s.vendorUserId,
          T.ORDER_CANCELLED,
          'Order cancelled',
          `Order ${short(s.id)} was cancelled by the buyer before shipping.`,
          { orderId: p.orderId, subOrderId: s.id },
        ),
      );
    case E.SUB_ORDER_SHIPPED:
      return [
        make(
          p.buyerId,
          T.ORDER_SHIPPED,
          'Your order has shipped',
          `Sent with ${p.courierName}, tracking number ${p.trackingNumber}. Confirm delivery when it arrives.`,
          { orderId: p.orderId, subOrderId: p.subOrderId },
        ),
      ];
    case E.FUNDS_RELEASED:
      return [
        make(
          p.vendorUserId,
          T.FUNDS_RELEASED,
          'Funds released',
          `${formatNaira(p.vendorNetKobo)} from order ${short(p.subOrderId)} is now in your wallet.`,
          { orderId: p.orderId, subOrderId: p.subOrderId },
        ),
      ];
    case E.DISPUTE_OPENED:
      return [
        make(
          p.vendorUserId,
          T.DISPUTE_OPENED,
          'Dispute opened',
          `The buyer opened a dispute on order ${short(p.subOrderId)}. Its funds are on hold; you can reply with your evidence.`,
          { disputeId: p.disputeId, subOrderId: p.subOrderId },
        ),
      ];
    case E.DISPUTE_RESOLVED: {
      const text = `The dispute on order ${short(p.subOrderId)} was ${RESOLUTION_TEXT[p.resolution] ?? 'resolved'}.`;
      const refund =
        p.refundKobo > 0 ? ` ${formatNaira(p.refundKobo)} was refunded to the buyer.` : '';
      return [p.buyerId, p.vendorUserId].map((userId) =>
        make(userId, T.DISPUTE_RESOLVED, 'Dispute resolved', text + refund, {
          disputeId: p.disputeId,
          resolution: p.resolution,
        }),
      );
    }
    case E.PAYOUT_SUCCEEDED:
      return [
        make(
          p.vendorUserId,
          T.PAYOUT_SUCCEEDED,
          'Payout sent',
          `${formatNaira(p.amountKobo)} was sent to your bank account.`,
          { payoutId: p.payoutId },
        ),
      ];
    case E.PAYOUT_FAILED:
      return [
        make(
          p.vendorUserId,
          T.PAYOUT_FAILED,
          'Payout failed',
          `Your payout of ${formatNaira(p.amountKobo)} failed and the money is back in your wallet. Reason: ${p.reason}.`,
          { payoutId: p.payoutId },
        ),
      ];
    default:
      return [];
  }
}

/** Called once by the worker at start-up. */
function registerNotificationHandlers() {
  for (const eventType of Object.values(E)) {
    registerHandler(eventType, (event) =>
      notificationsRepository.createMany(notificationsFor(event)),
    );
  }
}

module.exports = { notificationsFor, registerNotificationHandlers };
