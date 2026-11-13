# KoboMarket — handover for Claude Code

Read this after `CLAUDE.md`. `CLAUDE.md` holds the rules; this file holds the design decisions, what is already built, and the plan to finish. Where the two disagree, `CLAUDE.md` and the brief win.

- **Scope:** `docs/SCOPE.md` — the whole brief as a committed checklist. Check every feature against it. The original brief text may also exist locally as `docs/brief.md` (gitignored); it is optional.
- **Design doc (human copy):** https://claude.ai/artifact/5ip2hL4U3dCExhzuhjS7FZ. Everything you need from it is copied below.
- **Repo:** https://github.com/endrissuofe/kobomarket (public). CI: `test` (lint + unit) and `docker-smoke` (compose up, `/health/ready`, integration + concurrency tests, `audit:ledger`).

## 0. New machine setup

A fresh clone has none of the git-ignored files. Check for each one first; if any is missing, walk Drix through recreating it (he runs commands that need a browser or a secret).

| Missing                    | How to recreate it                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22                    | `nvm install 22 && nvm use` (repo has `.nvmrc`)                                                                                                                                                                                                                                             |
| `docs/brief.md` (optional) | Not needed: `docs/SCOPE.md` covers the brief. Drix may save the original there for exact wording                                                                                                                                                                                            |
| `.env.local` (Neon URLs)   | `npm ci` first (`neon.ts` needs `@neon/config`), `npm i -g neon@latest`, `neon login` (browser), then `neon env pull --project-id curly-resonance-15703720 --branch production --file .env.local` (CLI 9.x defaults to `.env` and overwrites its `DATABASE_URL`)                            |
| `.env`                     | `cp .env.example .env`, set `JWT_ACCESS_SECRET` to `openssl rand -hex 32`, then switch to the "Option B" database lines: `MONGO_URI` for this machine (local MongoDB: `mongodb://127.0.0.1:27017/kobomarket`, otherwise an Atlas URL); keep a placeholder `REDIS_URL` until Redis is needed |
| `.neon`                    | Not needed day to day; `neon env pull` takes the project and branch as flags. `neon init` recreates it if wanted                                                                                                                                                                            |

Then prove the setup before writing code: `npm ci`, `npm run lint`, `npm run migrate` (expect "Already up to date"), `npm test`, `npm run audit:ledger` (expect PASS).

Linux notes (Ubuntu 24.04): IPv6 on this machine is broken, so use `127.0.0.1` rather than `localhost`; if `npm`, `neon` or `curl` hang on a host lookup, prefer IPv4 (`export NODE_OPTIONS=--dns-result-order=ipv4first`). Local `mongod` needs its systemd `GLIBC_TUNABLES` override to start (already configured on Drix's machine).

## 1. Where the project stands (12 Nov 2026)

Started 5 Nov; the four-week clock ends around **3 Dec 2026**. Week 1's progress check is due now.

| Brief milestone                                                              | State                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Week 1: setup, Docker, migrations, auth, RBAC, vendors, products             | Setup, Docker (verified in CI), ledger migrations **done**. Auth, RBAC, vendors, products **not started — behind, do these next** |
| Week 2: wallets, ledger, funding + webhook, cart                             | Ledger core done early (`LedgerService`). Funding, webhook, cart not started                                                      |
| Week 3: checkout, escrow, state machine, auto-complete, disputes             | Not started                                                                                                                       |
| Week 4: payouts, notifications, admin reports, tests, Swagger, README, video | Not started                                                                                                                       |

### Built and tested

- `src/config` (Zod env validation, `.env.local` before `.env`), `src/shared` (errors, request-ID logger with redaction, error middleware, `money/kobo.js`), `/health` and `/health/ready`.
- `src/db/postgres.js`: Knex pool on the pooled Neon URL; BIGINT parsed to safe integers; `withTransaction(fn)`.
- Migrations: `accounts`, `transactions`, `ledger_entries` (UPDATE/DELETE/TRUNCATE refused by trigger on entries and transactions; deferred check that each transaction balances), system accounts seeded, `settings` (`commission_bps` 500, `escrow_timeout_hours` 72, `payout_min_kobo` 100000), `outbox_events`, `idempotency_keys`.
- `src/modules/ledger`:
  - `LedgerService.post({ reference, type, entries, idempotencyKey?, metadata? }, trx?)` — validates integer kobo and debits = credits, locks accounts in ascending ID order, refuses `ACCOUNT_FROZEN` (403) and `INSUFFICIENT_FUNDS` (422) on user accounts going down, refuses a reused reference with 409 `DUPLICATE_TRANSACTION`, writes entries and updates cached balances. Runs inside the caller's `trx` when given.
  - `openUserAccount(userId, trx?)`, `getSystemAccount(name, trx?)`, `getAccount(id, trx?)`, `audit(trx?)`.
  - Constants: `SYSTEM_ACCOUNTS` (PLATFORM_ESCROW, PLATFORM_REVENUE, PLATFORM_PAYOUT_CLEARING, EXTERNAL_PAYSTACK), `TRANSACTION_TYPES` (FUNDING, ESCROW_HOLD, ESCROW_RELEASE, REFUND, PAYOUT_HOLD, PAYOUT_SETTLE, PAYOUT_REVERSAL), `DIRECTIONS` (credit increases a balance).
- `npm run audit:ledger` (real; runs in CI after the tests).
- Tests: unit (kobo, posting validation), integration (Postgres, ledger), concurrency (parallel overdraft, opposite-direction transfers). Test helpers in `tests/helpers/ledger.js` (`makeWallet`, `fund`, `errorCode`).

### Known gaps to close later

- Integration tests run against Neon `production`. Create a Neon `test` branch and point tests at it.
- App connects as the table owner, so the trigger is the only guard on ledger rows. Add a restricted app role with UPDATE/DELETE revoked.
- MongoDB, auth, vendors, products, wallet funding, cart, checkout/orders and the BullMQ worker are done (13 Nov). Locally Redis is not installed yet, so the worker cannot run on this machine (tests do not need it); CI runs it in Docker. Reviews (product rating) wait for completed orders.

## 2. Data ownership

| Data                                                                                    | Owner      | Referenced from the other side by                                   |
| --------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| Users, sessions, verification tokens, login attempts                                    | MongoDB    | `accounts.owner_id` = Mongo user `_id` (string)                     |
| Vendor stores, bank details                                                             | MongoDB    | `sub_orders.vendor_id`, `payouts.vendor_id`                         |
| Products, variants, stock, catalogue price                                              | MongoDB    | `order_items.product_id` + **price snapshot in kobo**               |
| Carts, reviews, notifications                                                           | MongoDB    | —                                                                   |
| Wallets, ledger, transactions, orders, disputes, payouts, settings, outbox, idempotency | PostgreSQL | user doc keeps only `walletStatus` (PENDING/READY), never a balance |

A Mongo product price is a catalogue price, not money. The amount a buyer paid lives in Postgres.

## 3. Remaining PostgreSQL tables (create with `npm run migrate:make`)

- `orders` (id, buyer_id, status, total_kobo CHECK > 0, idempotency_key UNIQUE, escrow_txn_id, created_at)
- `sub_orders` (id, order_id FK, vendor_id, status, subtotal_kobo, **commission_bps snapshot at checkout**, courier_name, tracking_number, shipped_at, delivered_at, auto_complete_at, completed_at)
- `order_items` (id, sub_order_id FK, product_id, variant_sku, name_snapshot, unit_price_kobo CHECK > 0, qty CHECK > 0)
- `order_status_history` (sub_order_id, from_status, to_status, actor_id, reason, created_at) — append-only audit trail
- `disputes` (id, sub_order_id FK, buyer_id, reason, evidence JSONB, vendor_response, vendor_evidence JSONB, status OPEN/RESOLVED, resolution FULL_REFUND/PARTIAL_REFUND/REJECTED, refund_kobo, resolved_by, note NOT NULL when resolved, resolved_at) + partial unique index on (sub_order_id) WHERE status = 'OPEN'
- `payouts` (id, vendor_id, amount_kobo CHECK >= payout minimum at request time, status PENDING/SUCCESS/FAILED, provider_ref, failure_reason, hold_txn_id, settle_txn_id) + **partial unique index on (vendor_id) WHERE status = 'PENDING'**
- `webhook_events` (provider, event_id UNIQUE, payload JSONB, received_at, processed_at) — raw log of every webhook

Commission maths: `splitByBps(amount, bps)` from `kobo.js`. Commission rounds down; vendor gets the remainder.

## 4. MongoDB collections (Mongoose)

| Collection           | Key fields                                                                                                                                                       | Indexes                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `users`              | email, passwordHash (argon2id), roles [buyer, vendor, admin], emailVerifiedAt, status ACTIVE/FROZEN, walletStatus PENDING/READY                                  | email unique                                                                               |
| `sessions`           | userId, familyId, tokenHash, replacedBy, revokedAt, expiresAt, ip, userAgent                                                                                     | tokenHash unique; familyId; TTL on expiresAt                                               |
| `verificationTokens` | userId, type EMAIL/RESET, tokenHash, expiresAt, usedAt                                                                                                           | tokenHash unique; TTL                                                                      |
| `vendors`            | userId, storeName, slug, description, bank {bankCode, accountNumber, accountName}, status PENDING/APPROVED/REJECTED, rejectionReason, reviewedBy                 | userId unique; slug unique                                                                 |
| `products`           | vendorId, name, slug, description, category, priceKobo, stock, variants [{sku, attrs, priceKobo, stock}], tags, images, rating {avg, count}, isActive, deletedAt | slug unique; text(name, description); {category, priceKobo}; {vendorId}; {rating.avg, _id} |
| `carts`              | userId, items [{productId, variantSku, qty, addedPriceKobo}]                                                                                                     | userId unique                                                                              |
| `reviews`            | productId, buyerId, subOrderId, rating 1–5, comment                                                                                                              | {productId, buyerId} unique                                                                |
| `notifications`      | userId, type, title, body, data, readAt                                                                                                                          | {userId, readAt, _id}                                                                      |
| `loginAttempts`      | key (email + IP), count, windowStart                                                                                                                             | key unique; TTL 15 min                                                                     |
| `compensations`      | type (e.g. STOCK_RELEASE), payload, attempts, status                                                                                                             | status                                                                                     |

Notes:

- Stock decrement is one atomic update: `updateOne({ _id, 'variants.sku': sku, 'variants.stock': { $gte: qty } }, { $inc: { 'variants.$.stock': -qty } })`; `modifiedCount === 0` means out of stock. Same pattern on `stock` for products without variants.
- Cursor pagination: base64 of `{ sortValue, _id }`; query with `(field, _id)` tie-break so rows never repeat or skip.
- Rating: update with an atomic `$inc` on sum/count or an aggregate recompute, never read-modify-write in JS.
- Soft delete sets `deletedAt` and `isActive: false`; default queries exclude them.

## 5. Money flows (each is one `LedgerService.post()` call)

| Event                                      | Type            | Debit (−)                | Credit (+)                                                                         |
| ------------------------------------------ | --------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| Wallet funded (verified webhook)           | FUNDING         | EXTERNAL_PAYSTACK        | Buyer wallet                                                                       |
| Checkout                                   | ESCROW_HOLD     | Buyer wallet             | PLATFORM_ESCROW                                                                    |
| Cancel before ship / checkout compensation | REFUND          | PLATFORM_ESCROW          | Buyer wallet                                                                       |
| Sub-order completed                        | ESCROW_RELEASE  | PLATFORM_ESCROW          | Vendor wallet (net) + PLATFORM_REVENUE (commission)                                |
| Dispute: full refund                       | REFUND          | PLATFORM_ESCROW          | Buyer wallet                                                                       |
| Dispute: partial                           | REFUND          | PLATFORM_ESCROW          | Buyer (refund) + Vendor (rest − commission on rest) + REVENUE (commission on rest) |
| Dispute: rejected                          | ESCROW_RELEASE  | as completed             | as completed                                                                       |
| Payout requested                           | PAYOUT_HOLD     | Vendor wallet            | PLATFORM_PAYOUT_CLEARING                                                           |
| Payout succeeded                           | PAYOUT_SETTLE   | PLATFORM_PAYOUT_CLEARING | EXTERNAL_PAYSTACK                                                                  |
| Payout failed                              | PAYOUT_REVERSAL | PLATFORM_PAYOUT_CLEARING | Vendor wallet                                                                      |

Vendor wallets are opened with `openUserAccount(vendorUserId)` (a vendor is a user). References: Paystack reference for funding, `ORD-<id>`, `SUB-<id>-RELEASE`, `DSP-<id>`, `PAY-<id>-HOLD/-SETTLE/-REV` — the UNIQUE reference is what makes every money event happen at most once.

## 6. Sub-order state machine

One `TRANSITIONS` map in `src/modules/orders/state-machine.js`; services call `assertTransition(from, to)` inside the locked transaction (`SELECT ... FROM sub_orders WHERE id = ? FOR UPDATE`, re-check status after the lock) and write `order_status_history`. Anything else → 409 `INVALID_TRANSITION`.

| From → To                      | Who                                                             | Ledger                                                    |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| PENDING_PAYMENT → PAID         | Checkout (same transaction)                                     | ESCROW_HOLD                                               |
| PAID → CANCELLED               | Buyer, or checkout compensation                                 | REFUND                                                    |
| PAID → SHIPPED                 | Vendor who owns it; **courier name + tracking number required** | none; set `auto_complete_at = now + escrow_timeout_hours` |
| SHIPPED → DELIVERED            | Buyer confirms                                                  | none                                                      |
| DELIVERED → COMPLETED          | System, right after confirm                                     | ESCROW_RELEASE                                            |
| SHIPPED → COMPLETED            | Auto-complete job                                               | ESCROW_RELEASE                                            |
| SHIPPED / DELIVERED → DISPUTED | Buyer                                                           | none; escrow frozen, job skips it                         |
| DISPUTED → REFUNDED            | Admin, full refund                                              | REFUND                                                    |
| DISPUTED → COMPLETED           | Admin, partial or reject                                        | split per resolution                                      |

`REFUNDED` is an addition to the brief's states so a full refund has a clear end state. The parent order shows a status rolled up from its sub-orders. A cart from 3 vendors = 1 order + 3 sub-orders, one `ESCROW_HOLD` for the total.

### Delivery and fake "not received" claims (agreed with Drix)

- The vendor arranges delivery. Shipping requires `courierName` and `trackingNumber`.
- Disputes: buyer submits reason + evidence; the **vendor can reply with their own evidence** (`vendor_response`, `vendor_evidence`). Admin sees both.
- Delivery confirmation code (buyer reads a code to the rider) is a **README "future improvement"**, built only if time allows after all required tests pass.

## 7. Cross-database consistency

- **Wallet on registration:** create the Mongo user with `walletStatus: PENDING`, then `openUserAccount()` (idempotent by unique key), then set `READY`. If Postgres fails, registration still succeeds; a reconciler job retries users PENDING for more than 30 s. Money endpoints return 409 `WALLET_NOT_READY` until READY.
- **Checkout (reserve stock first):**
  1. Validate cart prices and stock against Mongo; stale price → 409 with the new prices.
  2. Reserve stock with conditional `$inc` per line; on any failure release what was reserved, 409 `OUT_OF_STOCK`. No money touched.
  3. One Postgres transaction: create order + sub-orders + items, `LedgerService.post(ESCROW_HOLD, trx)` (locks the wallet), write `outbox_events(ORDER_PLACED)`, save the idempotency response.
  4. If step 3 fails → release reserved stock (compensation), return the error. If the release itself fails, write a `compensations` doc; the reconciler retries it.
  - The brief's literal order is money first, then stock with a refund on failure. Explain the reserve-first choice in the README and ADR.
- **Outbox relay (worker):** `SELECT ... FROM outbox_events WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, push to BullMQ, mark SENT; exponential backoff; after 10 attempts → DEAD (admin-visible). All handlers idempotent.

## 8. Concurrency and idempotency

| Race                                | Guard                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| 10 checkouts, wallet affords 3      | Wallet row lock inside `LedgerService.post`; balance CHECK as backstop               |
| 2 buyers, last item                 | Mongo conditional `$inc`                                                             |
| 2 payouts same millisecond          | Vendor wallet lock + partial unique index on PENDING payouts                         |
| Confirm vs auto-complete vs dispute | `FOR UPDATE` on the sub-order, re-check status                                       |
| Duplicate webhook                   | UNIQUE `transactions.reference` = Paystack reference, plus `webhook_events.event_id` |
| Two workers, one job                | `FOR UPDATE SKIP LOCKED`                                                             |

**Idempotency-Key middleware** (checkout, wallet fund, payouts): require the header (400 if missing); SHA-256 of canonical sorted JSON body; `INSERT ... ON CONFLICT DO NOTHING` into `idempotency_keys` as IN_PROGRESS scoped to user + endpoint. Inserted → run handler and store status + body as COMPLETED (same transaction as the business write where possible). Not inserted → different hash: 409 `IDEMPOTENCY_KEY_REUSED`; COMPLETED: replay; IN_PROGRESS: 409 `REQUEST_IN_PROGRESS` (stale after 60 s may be taken over). Keys expire after 24 h.

## 9. Auth, security, cross-cutting

- Access token: JWT 15 min (`sub`, `roles`, `sid`). Refresh token: 32 random bytes, stored as SHA-256 hash, 7 days, rotated on every use within a `familyId`. **Presenting a token that was already rotated revokes every session for that user** (brief: all sessions).
- Login blocked until email verified (403 `EMAIL_NOT_VERIFIED`). Rate limit: 5 failed attempts per 15 min per email + IP (429). Email links logged to console.
- Password hashing: argon2 (or bcrypt if argon2 fails to build on Node 22/macOS 12).
- RBAC: `requireAuth`, `requireRole('vendor' | 'admin')`; ownership checks in services. Vendor role only after admin approval. Frozen users: no orders, no payouts (also enforced by the ledger's `ACCOUNT_FROZEN`).
- Webhook route uses `express.raw()` mounted **before** `express.json()`; HMAC SHA-512 compared with `crypto.timingSafeEqual`; then re-verify with Paystack's verify endpoint before crediting. `PAYMENT_PROVIDER=mock` must also send duplicate and badly signed webhooks for tests 4 and 5.
- Validation: Zod per route (`validate(schema)` middleware). Money inputs are positive integers.
- Swagger at `/api-docs` from per-module `*.docs.yaml`, with shared error shape and Idempotency-Key header components.

## 10. Plan to finish (in this order)

1. **Mongo wiring** — `src/db/mongo.js`, readiness check includes Mongo, Mongo integration test in CI (compose already has `mongo`). Locally: the Ubuntu machine's own MongoDB (`127.0.0.1`), or an Atlas URL on the Mac.
2. **Auth** (Module A) — register (+ wallet), verify email, login, refresh rotation + reuse detection, logout, forgot/reset, login rate limit. Tests 1, 2.
3. **RBAC + vendors** (Module B) — apply, admin approve/reject, `GET /vendors/:id`. Test 3.
4. **Products** — CRUD with variants, soft delete, text search, filters, sort, cursor pagination.
5. **Wallet + funding** (Module E) — payment provider interface (Paystack + mock), `POST /wallet/fund` (idempotent), webhook, `GET /wallet`, `/wallet/transactions`. Tests 4, 5.
6. **Cart** (Module C).
7. **Checkout + orders** (Module F) — tables, state machine, checkout with compensation, ship, confirm, cancel, release. Tests 6–11.
8. **Redis + BullMQ worker** — outbox relay, auto-complete (skips DISPUTED), wallet reconciler, notifications. Test 12. Locally: `sudo apt install redis-server` on Ubuntu (`redis://127.0.0.1:6379`), or an Upstash URL on the Mac.
9. **Disputes** (Module G) — open, vendor reply, admin resolve. Test 13.
10. **Payouts** (Module H) — request, processor job, success/failure. Test 14 + double-payout race.
11. **Notifications** (Module I) and **Admin + reports** (Module J) — reports in SQL, not JS loops.
12. **Seed** (admin, 3 vendors, 20 products, 5 funded buyers — funded through the ledger), Swagger complete, Postman collection, README sections, ERD, ADRs. Test 15 (`audit:ledger` after the full suite).

Rule: no bonus work until all 15 required tests pass and `audit:ledger` is green.

## 11. Required tests (brief section 8) — map each to a file

1 login before verify fails · 2 reused refresh token kills all sessions · 3 buyer blocked from vendor/admin routes · 4 duplicate webhook credits once · 5 bad signature rejected · 6 insufficient balance: no order, no ledger rows · 7 10 concurrent checkouts, wallet affords 3 → exactly 3 · 8 2 buyers, last item → exactly 1 · 9 same Idempotency-Key → one order · 10 PAID → COMPLETED rejected · 11 completion splits vendor/revenue correctly · 12 disputed sub-order skipped by auto-complete · 13 partial refund keeps ledger balanced · 14 failed payout returns money · 15 `audit:ledger` passes after the suite.

## 12. Grading and deductions

Marks: ledger + PG schema 15, checkout/escrow/state machine 15, auth/RBAC/security 10, products/search/reviews 10, funding/webhook/idempotency 10, concurrency 10, disputes/refunds/payouts 10, cross-DB consistency 5, tests 5, code quality 5, docs/README/Swagger/video 5.

Deductions to make impossible: floats for money (−10; ESLint + BIGINT + Zod ints), ledger rows updated or deleted (−10; trigger), secrets committed (−5; gitignore; consider gitleaks in CI), doesn't start from README (−10; CI `docker-smoke`).

Bonus (only after the above): BullMQ with retries + dead-letter queue, CI (done), deploy (Render/Railway), Socket.io notifications. Skip multi-currency and coupons.

## 13. Submission checklist

- Source, `.env.example`, Swagger at `/api-docs`, Postman collection (`docs/postman/`, pre-request script sets a fresh Idempotency-Key), `npm test`.
- README: quick start (`docker compose up` + `npm run seed`), architecture diagram, PostgreSQL ERD (generate from the live schema), MongoDB collections, why two databases, consistency/concurrency/idempotency (link the proving tests), known limitations.
- Demo video 5–10 min: fund wallet → checkout (2 vendors) → ship → confirm → payout, then a dispute with partial refund; end on `npm run audit:ledger` PASS.

## 14. Open questions for Drix

- Will the marker accept reserve-first checkout? (Ask at the progress check.)
- ~~Should a vendor be blocked from buying from their own store?~~ Decided 13 Nov: yes (brief is silent; recorded in README "Assumptions").
- Auto-complete 72 h after DELIVERED too, or only after SHIPPED as the brief says?
