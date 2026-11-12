# KoboMarket — project rules for Claude Code

Individual 4-week final project: a multi-vendor marketplace **backend** with wallets, a double-entry ledger and escrow. No frontend is graded. The assignment brief is the source of truth.

**Start every session by reading `docs/HANDOVER.md`** (design decisions, what is built, money flows, state machine, the ordered plan to finish). The brief is at `docs/brief.md`, kept local and gitignored because the repo is public; if it is missing, ask Drix for it.

## Stack

Node.js 22 (CommonJS) · Express · Knex + `pg` on PostgreSQL (Neon) · Mongoose on MongoDB · Redis + BullMQ (later) · Zod · pino · Jest + Supertest.

## Environment

- Developer machine: 2015 MacBook Pro on macOS 12 Monterey. **No Docker locally.** Stay on Node 22 (`.nvmrc`).
- Postgres is Neon. `neon env pull --project-id curly-resonance-15703720 --branch production` writes `.env.local` with `DATABASE_URL` (pooled, app traffic) and `DATABASE_URL_UNPOOLED` (direct, migrations).
- `src/config/loadEnv.js` loads `.env.local` first, then `.env`. Never commit either.
- Docker is verified only in GitHub Actions (`docker-smoke` job runs `docker compose up`, checks `/health/ready`, runs Postgres integration tests). Check the Actions tab after every push.

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
- [ ] **Next:** Auth (MongoDB), RBAC, vendors, products (CRUD + search, cursor pagination)
- [ ] Later: separate Neon `test` branch for integration tests (they currently run against `production`); restricted app DB role with UPDATE/DELETE revoked on ledger tables (the app connects as table owner today, so the trigger is the real guard)

## Ledger testing note

The ledger is append-only and TRUNCATE is blocked, so tests never wipe tables. Each test opens its own wallets with a unique owner id (`tests/helpers/ledger.js`) and funds them through `LedgerService.post()`. Assert on your own accounts, not on global counts.
