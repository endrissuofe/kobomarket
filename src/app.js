const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const config = require('./config');
const { logger } = require('./shared/logger');
const requestId = require('./shared/middleware/requestId');
const { notFoundHandler, errorHandler } = require('./shared/middleware/errorHandler');
const postgres = require('./db/postgres');
const mongo = require('./db/mongo');

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
    const probes = { postgres: postgres.ping, mongo: mongo.ping };
    const checks = {};
    await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => {
        try {
          await probe();
          checks[name] = 'ok';
        } catch (err) {
          req.log.error({ err }, `${name} readiness check failed`);
          checks[name] = 'unreachable';
        }
      }),
    );
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: { status: ready ? 'ready' : 'not_ready', checks },
    });
  });

  // Module routers, all under /api/v1.
  app.use('/api/v1/auth', require('./modules/auth/auth.routes'));
  app.use('/api/v1/users', require('./modules/users/users.routes'));
  app.use('/api/v1/vendors', require('./modules/vendors/vendors.routes'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
