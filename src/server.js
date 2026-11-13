const config = require('./config');
const { logger } = require('./shared/logger');
const { createApp } = require('./app');
const postgres = require('./db/postgres');
const mongo = require('./db/mongo');

let server;

async function start() {
  // Mongo holds users and the catalogue; without it no request can be served.
  await mongo.connect();
  logger.info('MongoDB connected');

  server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'KoboMarket API listening');
  });
}

// Finish in-flight requests before exit (Docker sends SIGTERM).
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  const finish = async () => {
    await Promise.allSettled([postgres.close(), mongo.close()]);
    process.exit(0);
  };
  if (server) server.close(finish);
  else finish();
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
