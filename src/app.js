const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { rateLimit } = require('express-rate-limit');

const config = require('./config');
const { logger } = require('./shared/logger');
const requestId = require('./shared/middleware/requestId');
const { notFoundHandler, errorHandler } = require('./shared/middleware/errorHandler');
const postgres = require('./db/postgres');
const mongo = require('./db/mongo');

/**
 * @param {{ rateLimit?: { windowMs: number, max: number } }} [options] overrides for tests
 */
function createApp(options = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));

  // Webhooks use express.raw() and must mount BEFORE express.json(), so the
  // HMAC is checked against the exact bytes the provider sent.
  app.use('/api/v1/webhooks', require('./modules/webhooks/webhooks.routes'));

  // General rate limit per IP for the API (the webhook above and the health
  // checks are not limited). Login has its own stricter per-email limit.
  const limits = options.rateLimit ?? config.rateLimit;
  if (limits.max > 0) {
    app.use(
      '/api/v1',
      rateLimit({
        windowMs: limits.windowMs,
        limit: limits.max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, res) =>
          res.status(429).json({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' },
          }),
      }),
    );
  }

  app.use(express.json({ limit: '100kb' }));

  if (config.payments.provider === 'mock') {
    app.use('/mock-paystack', require('./integrations/payments/mock.routes'));
  }

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
  app.use('/api/v1/admin/vendors', require('./modules/vendors/vendors.admin.routes'));
  app.use('/api/v1/products', require('./modules/products/products.routes'));
  app.use('/api/v1/wallet', require('./modules/wallet/wallet.routes'));
  app.use('/api/v1/cart', require('./modules/cart/cart.routes'));
  app.use('/api/v1/orders', require('./modules/orders/orders.routes'));
  app.use('/api/v1/sub-orders', require('./modules/orders/sub-orders.routes'));
  app.use('/api/v1/disputes', require('./modules/disputes/disputes.routes'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
