const config = require('./config');
const { logger } = require('./shared/logger');
const { createApp } = require('./app');
const postgres = require('./db/postgres');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'KoboMarket API listening');
});

// Finish in-flight requests before exit (Docker sends SIGTERM).
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await postgres.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
