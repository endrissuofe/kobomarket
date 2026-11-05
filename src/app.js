const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const config = require('./config');
const { logger } = require('./shared/logger');
const requestId = require('./shared/middleware/requestId');
const { notFoundHandler, errorHandler } = require('./shared/middleware/errorHandler');
const postgres = require('./db/postgres');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));

  // The Paystack webhook route will mount here with express.raw() BEFORE json(),
  // so the HMAC is checked against the exact bytes Paystack sent.

  app.use(express.json({ limit: '100kb' }));

  // Liveness: the process is up.
  app.get('/health', (req, res) => {
    res.json({ success: true, data: { status: 'ok' } });
  });

  // Readiness: the process can reach its databases.
  app.get('/health/ready', async (req, res) => {
    const checks = {};
    try {
      await postgres.ping();
      checks.postgres = 'ok';
    } catch (err) {
      req.log.error({ err }, 'Postgres readiness check failed');
      checks.postgres = 'unreachable';
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { status: ready ? 'ready' : 'not_ready', checks },
    });
  });

  // Module routers mount under /api/v1 as they are built, e.g.:
  // app.use('/api/v1/auth', require('./modules/auth/auth.routes'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
