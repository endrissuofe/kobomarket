const { logger } = require('./shared/logger');

// Background process. Same code as the API, separate container.
// Jobs register here as they are built (see src/jobs/):
//   outbox-relay, auto-complete, payout-processor, wallet-reconciler, notifications

logger.info('KoboMarket worker started (no jobs registered yet)');

// Keep the process alive until jobs are added.
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown(signal) {
  logger.info({ signal }, 'Worker shutting down');
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
