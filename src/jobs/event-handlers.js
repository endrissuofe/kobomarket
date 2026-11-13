const { logger } = require('../shared/logger');

/**
 * What happens when an outbox event reaches the worker, by event type.
 * Delivery is at least once, so every handler must be idempotent.
 * Notifications (plan step 11) register their handlers here.
 */
const handlers = new Map();

function registerHandler(eventType, fn) {
  if (!handlers.has(eventType)) handlers.set(eventType, []);
  handlers.get(eventType).push(fn);
}

async function handleEvent(event) {
  const list = handlers.get(event.eventType) ?? [];
  if (list.length === 0) {
    logger.debug(
      { eventType: event.eventType, outboxId: event.outboxId },
      'No handler; acknowledged',
    );
    return;
  }
  for (const fn of list) await fn(event);
}

module.exports = { registerHandler, handleEvent };
