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

### Running without Docker

Requires **Node.js 22** (newer major versions need a newer macOS).

```bash
cp .env.example .env   # then switch to Option B in the Databases section
npm install
npm run migrate
npm run dev            # API
npm run dev:worker     # background jobs, in a second terminal
```

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

## Assumptions and design decisions

Points the brief leaves open, and what KoboMarket does about them.

- **Vendors cannot buy their own products.** The brief allows one account to be both buyer and vendor but says nothing about self-purchase. Blocking it (at add-to-cart and again at checkout) stops a vendor faking sales to climb the "top vendors" report.
- **Frozen users can still fund their wallet.** The brief blocks orders and withdrawals for frozen accounts; money coming in is harmless.
- **A rejected vendor may apply again**, which puts the same application back to PENDING. Only approved stores are visible publicly.
- **Product stock is set absolutely by the vendor** (`PATCH /products/:id`). If a checkout decrements stock between the vendor reading and saving, the vendor's number wins. A delta endpoint using `$inc` would close this; listed under known limitations.
- **No relevance ordering for product search.** Search narrows results and the chosen sort orders them, because a text-relevance score cannot be used as a pagination cursor.
- **Checkout reserves stock first, then takes money.** The brief's order is money first, then stock with a refund if stock fails. Reserving first (one conditional `$inc` per line, all or nothing) means a sold-out item never touches the wallet, and if the Postgres transaction fails the stock is simply put back; a put-back that itself fails is saved as a `compensations` document for the reconciler.
- **Inside the checkout transaction the escrow hold is posted before the order rows.** That takes the wallet row lock first; inserting the order first took a foreign-key share lock on the wallet and parallel checkouts deadlocked upgrading it (found by the 10-concurrent-checkouts test).
- **A changed price stops checkout.** The cart is updated to the live price and the buyer checks out again, so nobody pays a price they have not seen.
- **Cancelling is all or nothing.** An order can be cancelled only while every sub-order is still PAID; if any vendor has shipped, the cancel is refused.
- **The commission rate is snapshotted per sub-order at checkout**, so an admin changing the rate later does not change what was agreed.
- **Order status is derived** from the sub-orders (their shared status, or `IN_PROGRESS`), never stored, so the two cannot disagree.
- **Shipping requires a courier name and tracking number.**
- **Vendors list their own sub-orders** at `GET /vendors/me/sub-orders` (not in the brief's endpoint list, but vendors must be able to "view orders").
- **The API never talks to Redis.** Every business change writes an `outbox_events` row in the same Postgres transaction; the worker relays those rows to a BullMQ queue. If Redis is down, checkouts still work and events wait in the outbox. Relaying claims rows with `FOR UPDATE SKIP LOCKED` and a short lease, publishes after the transaction (no network call while holding row locks), and backs off then marks a row `DEAD` after 10 failures. Delivery is at least once, so event handlers are idempotent.
- **Scheduled jobs are safe to run on several workers at once.** Auto-complete re-locks each sub-order with `status = 'SHIPPED'` and `SKIP LOCKED` (so a disputed or just-confirmed sub-order is skipped, and escrow is released once); compensation retries are claimed with a lease.
