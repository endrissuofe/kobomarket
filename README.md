# KoboMarket

A multi-vendor marketplace backend. Buyers pay into escrow from a wallet; money is released to vendors when the buyer confirms delivery or 72 hours after shipping. Every naira movement is recorded in a double-entry ledger in PostgreSQL.

**Stack:** Node.js 22 · Express · MongoDB (catalogue, users) · PostgreSQL (money) · Redis + BullMQ (jobs)

## Quick start

```bash
cp .env.example .env
docker compose up -d
docker compose exec api npm run seed
```

- API: http://localhost:3000
- Health: http://localhost:3000/health
- API docs: http://localhost:3000/api-docs (coming in Week 4)

## Project structure

```text
src/
  app.js, server.js, worker.js   express app, HTTP entry, background worker entry
  config/                        env validation (fails fast on boot)
  db/                            postgres (knex), mongo (mongoose), redis
  shared/                        errors, middleware, money helpers, logger, events
  integrations/payments/         Paystack + mock provider behind one interface
  modules/<feature>/             routes → controller → service → repository
  jobs/                          outbox relay, auto-complete, payouts, reconciler
migrations/   seeds/   scripts/   tests/   docs/
```

## Sections still to write

- Architecture diagram
- PostgreSQL ERD and MongoDB collections
- Why two databases
- Cross-database consistency, concurrency and idempotency
- Running tests and `npm run audit:ledger`
- Known limitations
