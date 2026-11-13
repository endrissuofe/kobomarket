// Background worker: same code as the API, separate process/container.
// The API never talks to Redis; it writes outbox rows and the worker relays
// them. Scheduled jobs run through BullMQ (retries, backoff, failed set).
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const config = require('./config');
const { logger } = require('./shared/logger');
const postgres = require('./db/postgres');
const mongo = require('./db/mongo');
const { relayOutbox } = require('./jobs/outbox-relay');
const { runAutoComplete } = require('./jobs/auto-complete');
const { runWalletReconciler } = require('./jobs/wallet-reconciler');
const { runCompensationRetry } = require('./jobs/compensation-retry');
const { runIdempotencyCleanup } = require('./jobs/idempotency-cleanup');
const { handleEvent } = require('./jobs/event-handlers');

const EVENT_ATTEMPTS = 5;

// Scheduled jobs: name -> { every (ms), run }.
const SCHEDULE = {
  'outbox-relay': { every: 2_000, run: () => relayOutbox({ publish: publishEvent }) },
  'auto-complete': { every: 60_000, run: () => runAutoComplete() },
  'wallet-reconciler': { every: 30_000, run: () => runWalletReconciler() },
  'compensation-retry': { every: 60_000, run: () => runCompensationRetry() },
  'idempotency-cleanup': { every: 24 * 3_600_000, run: () => runIdempotencyCleanup() },
};

// BullMQ needs maxRetriesPerRequest: null on its connections.
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, family: 4 });
const scheduler = new Queue('maintenance', { connection });
const events = new Queue('events', { connection });

/** Outbox -> events queue. The outbox id is the job id, so a row is queued once. */
function publishEvent(event) {
  return events.add(event.eventType, event, {
    jobId: `outbox-${event.outboxId}`,
    attempts: EVENT_ATTEMPTS,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: 1_000,
    // Failed jobs are kept: BullMQ's failed set is the dead-letter queue.
    removeOnFail: false,
  });
}

const workers = [];

async function start() {
  await mongo.connect();
  await postgres.ping();

  for (const [name, { every }] of Object.entries(SCHEDULE)) {
    await scheduler.upsertJobScheduler(
      name,
      { every },
      { name, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  // One maintenance job at a time; each job is also safe to run in parallel
  // (SKIP LOCKED, leases), so running several workers is fine.
  workers.push(
    new Worker('maintenance', (job) => SCHEDULE[job.name]?.run(), { connection, concurrency: 1 }),
    new Worker('events', (job) => handleEvent(job.data), { connection, concurrency: 5 }),
  );

  for (const w of workers) {
    w.on('failed', (job, err) => {
      const dead = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      logger[dead ? 'error' : 'warn'](
        { err, queue: w.name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade },
        dead ? 'Job failed for good (kept in the failed set)' : 'Job failed; will retry',
      );
    });
  }
  logger.info({ jobs: Object.keys(SCHEDULE) }, 'KoboMarket worker started');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Worker shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([scheduler.close(), events.close()]);
  await Promise.allSettled([connection.quit(), postgres.close(), mongo.close()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
