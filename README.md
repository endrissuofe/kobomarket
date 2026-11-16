# KoboMarket

A multi-vendor marketplace backend. Buyers pay into escrow from a wallet; money is released to vendors when the buyer confirms delivery or 72 hours after shipping. Every naira movement is recorded in a double-entry ledger in PostgreSQL.

**Stack:** Node.js 22 · Express · MongoDB (catalogue, users) · PostgreSQL (money) · Redis + BullMQ (jobs)

## Quick start

```bash
cp .env.example .env
docker compose up -d
docker compose exec api npm run seed
```

`npm run seed` adds demo data and is safe to run again (nothing is created or credited twice):

| Role   | Email                                                                  | Notes                                                  |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Admin  | `admin@kobomarket.test`                                                |                                                        |
| Vendor | `ada@kobomarket.test`, `tunde@kobomarket.test`, `musa@kobomarket.test` | Approved stores with 20 products between them          |
| Buyer  | `chioma@`, `emeka@`, `fatima@`, `kunle@`, `ngozi@kobomarket.test`      | Wallets funded through the ledger (₦50,000–₦1,000,000) |

Every demo account's password is `KoboMarket#2026`. Demo data only: it refuses to run with `NODE_ENV=production`.

- API: http://localhost:3000
- Health: http://localhost:3000/health
- API docs (Swagger UI): http://localhost:3000/api-docs · raw OpenAPI JSON: http://localhost:3000/api-docs.json

### Running without Docker

Requires **Node.js 22** (newer major versions need a newer macOS).

```bash
cp .env.example .env   # then switch to Option B in the Databases section
npm install
npm run migrate
npm run seed           # demo data (optional)
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
migrations/   seeds/ (demo data)   scripts/ (seed, audit, make-admin)   tests/   docs/
```

## Why two databases

I use two databases because KoboMarket keeps two very different kinds of data.

**MongoDB is the shop window.** It holds users, vendor stores, products (with their variants and stock), carts, reviews and notifications. This data changes shape often: one product has sizes and colours, another has none, and a store can gain new fields. MongoDB lets each document carry what it needs without a migration every time, and its text search and flexible filters suit the product catalogue.

**PostgreSQL is the bank vault.** It holds wallets, the double-entry ledger, orders and sub-orders, disputes, payouts and settings. Money needs strict rules, and PostgreSQL enforces them itself, even if my code has a bug:

- **Transactions:** a checkout either happens completely or not at all.
- **Row locks** (`SELECT ... FOR UPDATE`): two payments cannot spend the same naira.
- **Constraints and triggers:** amounts are whole kobo in `BIGINT`, every transaction must balance to zero, and ledger rows can never be edited or deleted.

**The rule between them: money lives only in PostgreSQL.** MongoDB never holds a balance. A product price in MongoDB is only the catalogue price; what the buyer actually paid is copied into PostgreSQL at checkout (`order_items.unit_price_kobo`). The two sides are linked by IDs: a PostgreSQL account stores the MongoDB user's `_id` as `owner_id`.

**The cost:** one checkout touches both databases, so they could get out of step if one save works and the other fails. I handle that this way:

1. Reserve the stock in MongoDB first, then take the money in PostgreSQL.
2. If the PostgreSQL step fails, put the stock back.
3. If putting it back also fails, save a `compensations` record that a background job retries.
4. Every follow-up event is written to an `outbox_events` table in the same PostgreSQL transaction, so no event is lost even if Redis is down.

## Sections still to write

- Architecture diagram
- PostgreSQL ERD and MongoDB collections
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
- **Disputes are opened before confirming delivery.** Confirming means "I am satisfied": it moves the sub-order through DELIVERED to COMPLETED and releases the money in one step, so the brief's DELIVERED → DISPUTED move exists in the state machine but is not reached. A buyer with a problem disputes while the sub-order is SHIPPED, which also stops auto-complete.
- **`REFUNDED` is an extra sub-order state** for a fully refunded dispute, so it does not look like a completed sale. A partial refund or a rejected dispute ends `COMPLETED`.
- **A partial refund is one balanced posting**: escrow → buyer (refund), vendor (the rest minus commission) and revenue (commission on the rest only).
- **Vendors can reply to a dispute once with their own evidence**, and admins see both sides. `GET /disputes/mine` lists a user's disputes as buyer or vendor.
- **Refunds do not restock.** The goods have shipped; returns handling is out of scope.
- **Payouts: hold first, transfer later.** A request moves the money from the vendor wallet to `PLATFORM_PAYOUT_CLEARING` at once (posted before the payout row, so the wallet is locked first); a worker sends the transfer outside any database transaction and then settles (clearing → `EXTERNAL_PAYSTACK`) or reverses (clearing → vendor). Two requests in the same millisecond queue on the wallet lock; the second fails on funds or on the one-PENDING-payout index and rolls back. The payout id is the transfer reference, so a retried transfer cannot pay twice.
- **A provider error never reverses a payout.** We cannot know whether the money left, so the payout stays PENDING and is retried (an error is logged after 10 attempts for an admin). Only a definite "failed" from the provider returns the money. While a payout is PENDING the vendor cannot request another (the brief's rule).
- **Bank details are copied onto each payout** when it is requested, so a later change of bank account cannot redirect a payout in flight.
- **Reviews need a completed order**, checked in PostgreSQL (where orders live): a sub-order in `COMPLETED` containing the product. One review per buyer per product (unique index). The product's rating is one atomic MongoDB pipeline update that adds to `rating.sum` and `rating.count` and recomputes `rating.avg` from them, so parallel reviews never lose a vote.
- **Freezing a user acts in both databases.** The user is marked `FROZEN` in MongoDB (checkout and payouts refuse them) and their wallet is marked `FROZEN` in PostgreSQL, so `LedgerService.post()` itself refuses any debit from it, even from a code path that forgot to check. Refunds can still be credited. Freeze and unfreeze are safe to repeat; an admin cannot freeze themselves.
- **Reports are computed in SQL**, never in JavaScript loops, and count days and months in Lagos time (`Africa/Lagos`). Revenue per day lists every day in the range, with zero for days without sales. Top vendors count sub-orders completed this month, net of partial refunds. The escrow report shows the `PLATFORM_ESCROW` balance beside the unfinished sub-orders that should account for it.
- **`GET /admin/transactions`** lists every ledger transaction with its entries; it is not in the brief's endpoint list but delivers "view all transactions" from the admin role.
- **A commission change applies to new checkouts only** and is capped at 50% to stop a typo handing the platform the whole sale.
