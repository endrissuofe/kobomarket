# KoboMarket — project rules for Claude Code

Individual 4-week final project: a multi-vendor marketplace **backend** with wallets, a double-entry ledger and escrow. No frontend is graded. The assignment brief is the source of truth.

**Start every session by reading `docs/SCOPE.md` and `docs/HANDOVER.md`.**

- `docs/SCOPE.md` is the assignment brief as a committed checklist: every requirement, endpoint, required test, mark and deduction. **Scope rule:** before building anything, name the SCOPE line it delivers. If there is none and it isn't listed under "Deliberate additions" or "Bonus", it is out of scope: stop and ask Drix. Tick SCOPE boxes only when built and proven by a test or a manual check.
- `docs/HANDOVER.md` holds the design decisions, money flows, state machine and the ordered plan to finish.
- The original brief text is optional: `docs/brief.md` if Drix has saved it locally (gitignored, because the repo is public). When present, it settles any wording question.

## Stack

Node.js 22 (CommonJS) · Express · Knex + `pg` on PostgreSQL (Neon) · Mongoose on MongoDB · Redis + BullMQ (later) · Zod · pino · Jest + Supertest.

## Environment

- Drix works from more than one machine. Every machine starts from a fresh clone, so nothing outside git exists until it is recreated: `.env`, `.env.local`, `.neon` and `docs/brief.md` must be set up per machine (see `docs/HANDOVER.md` → "New machine setup").
  - Ubuntu 24.04 (current): Node 22 via nvm. MongoDB 8 runs locally (`mongodb://127.0.0.1:27017/kobomarket`). Use `127.0.0.1`, not `localhost`: the machine's IPv6 is broken and `localhost` can resolve to `::1`. Docker Engine can run here if installed.
  - 2015 MacBook Pro, macOS 12: no Docker. Use cloud MongoDB (Atlas).
- Stay on Node 22 (`.nvmrc`) on every machine.
- Postgres is Neon. After `npm ci` (`neon.ts` imports `@neon/config`), `neon env pull --project-id curly-resonance-15703720 --branch production --file .env.local` writes `.env.local` with `DATABASE_URL` (pooled, app traffic) and `DATABASE_URL_UNPOOLED` (direct, migrations). Always pass `--file .env.local`: neon CLI 9.x writes to `.env` by default and overwrites its `DATABASE_URL`.
- `src/config/loadEnv.js` loads `.env.local` first, then `.env`. Never commit either.
- Docker is always verified in GitHub Actions (`docker-smoke` job runs `docker compose up`, checks `/health/ready`, runs Postgres integration tests). Check the Actions tab after every push.

## Hard rules (each one is a grading deduction or core requirement)

1. **Money is integer kobo** (₦1 = 100 kobo), stored as `BIGINT`. No floats, no `DECIMAL` with JS numbers, no `parseFloat`/`toFixed` in money modules (ESLint enforces). Use `src/shared/money/kobo.js`. Commission is basis points (500 = 5%); commission rounds down, the vendor gets the remainder.
2. **Money lives only in PostgreSQL.** MongoDB never holds a balance or amount as source of truth.
3. **Ledger is append-only.** Never `UPDATE` or `DELETE` `ledger_entries`; fix mistakes with reversing entries. Enforce with a DB trigger. Only `src/modules/ledger` writes ledger entries or `balance_kobo`; other modules call `LedgerService.post()`, which refuses entries that don't net to zero.
4. **No secrets in git.** `.env`, `.env.*`, `.neon` are ignored. Only `.env.example` is committed.
5. **README quick start must work** (`docker compose up` + seed). CI proves it.

## Architecture

- Feature modules in `src/modules/<name>/`, each with `*.routes.js → *.controller.js → *.service.js → *.repository.js`, plus `*.schemas.js` (Zod) and `*.docs.yaml` (OpenAPI).
- Controllers: no business logic, no DB. Services: all business logic, own transactions (pass `trx` down). Repositories: the only code that touches SQL or Mongoose.
- RBAC via `requireRole()` middleware on routes, never `if (user.role === ...)` in controllers.
- Errors: throw `AppError` helpers from `src/shared/errors`; response shape is `{ success: false, error: { code, message, details } }`.
- Concurrency: `SELECT ... FOR UPDATE` on wallet rows; lock multiple accounts in ascending ID order; conditional `$inc` for Mongo stock. No HTTP calls inside DB transactions.
- Idempotency-Key header on checkout, wallet fund, payouts (table `idempotency_keys`; same key + different body → 409).
- Cross-DB consistency: transactional outbox (`outbox_events`) + compensation inside checkout. Checkout reserves stock first, then takes money.
- Extra system account `EXTERNAL_PAYSTACK` is the counterparty for funding and payouts, so the whole ledger sums to zero.

## Workflow

- Small commits, Conventional Commits (`feat(ledger): ...`), push often. The brief penalises one giant commit.
- Before each commit: `npm run lint` and `npm test` (integration tests need `.env.local`).
- New Postgres schema only through `npm run migrate:make <name>`; migrations are never edited after they are pushed.

## Status (update as work lands)

- [x] Scaffold, config validation, logger with request IDs, error middleware, money helpers, CI with Docker smoke test
- [x] Postgres wired (pooled for app, direct for migrations), `/health/ready`
- [x] Week 1 ledger: migrations for `accounts`, `transactions`, `ledger_entries` (UPDATE/DELETE/TRUNCATE blocked on entries and transactions; deferred balanced check), system accounts, `settings` (+ defaults), `outbox_events`, `idempotency_keys`; `LedgerService.post()` (`src/modules/ledger`); unit, integration and concurrency tests; real `npm run audit:ledger` (also runs in CI)
- [x] MongoDB wired (`src/db/mongo.js`, indexes built in `connect()`, readiness checks both DBs)
- [x] Auth (Module A): register (+ wallet, PENDING on failure), verify email, login (5 per 15 min per email + IP), refresh rotation with reuse → all sessions revoked, logout, forgot/reset; `requireAuth` / `requireRole` (`src/shared/middleware/auth.js`); `GET /users/me`. Required tests 1 and 2 in `tests/integration/auth.*.test.js`
- [x] Vendors (Module B): apply (re-apply after rejection), `GET /vendors/me`, public `GET /vendors/:id` (approved only, no bank details), admin list/approve/reject under `/admin/vendors` (approve is idempotent and grants the `vendor` role); `npm run make-admin -- <email>`. Required test 3 in `tests/integration/rbac.test.js`: add every new vendor/admin route to its tables
- [x] Products: create (approved store), get by slug, owner-only PATCH/DELETE (soft), `GET /products` (text search, category/price/vendor/rating filters, newest/price/rating sorts, keyset cursors bound to their sort), `GET /vendors/me/products`. With variants, `priceKobo` = lowest variant price and `stock` = total. Known limitation: PATCH sets stock absolutely
- [x] Wallet + funding (Module E): `wallet_fundings` + `webhook_events` tables; provider interface `src/integrations/payments` (Paystack + mock; mock checkout at `/mock-paystack/checkout/:ref/pay` sends the signed webhook twice); generic `idempotent()` middleware (`src/shared/middleware/idempotency.js`); `POST /wallet/fund`, `POST /webhooks/paystack` (raw body, HMAC, re-verify, credit once), `GET /wallet`, `GET /wallet/transactions`. Required tests 4 and 5 in `tests/integration/wallet.webhook.test.js`
- [x] Cart (Module C): `GET /cart` reviews every line against live products (`cartService.review`, flags PRICE_CHANGED / INSUFFICIENT_STOCK / UNAVAILABLE / OWN_PRODUCT; checkout must reuse it), add (atomic merge), PATCH qty, DELETE. Vendors cannot buy their own products (README "Assumptions")
- [ ] **Next:** checkout + orders (Module F): `orders`, `sub_orders`, `order_items`, `order_status_history` migrations, state machine, checkout (reserve stock, then one PG transaction with ESCROW_HOLD + outbox), cancel, ship, confirm, release; required tests 6-11
- [ ] Later: separate Neon `test` branch for integration tests (they currently run against `production`); restricted app DB role with UPDATE/DELETE revoked on ledger tables (the app connects as table owner today, so the trigger is the real guard)

## Ledger testing note

The ledger is append-only and TRUNCATE is blocked, so tests never wipe tables. Each test opens its own wallets with a unique owner id (`tests/helpers/ledger.js`) and funds them through `LedgerService.post()`. Assert on your own accounts, not on global counts. Auth tests do the same with a unique email per test (`tests/helpers/auth.js`); in tests the console mailer keeps emails in memory and `tokenFromEmail()` reads the token.
