# KoboMarket — scope checklist

Every requirement in the assignment brief, restated in our own words as a checklist. This file is committed so every clone has it; the original brief stays private (the repo is public). If `docs/brief.md` exists locally, it is the final word on any wording question.

**How Claude Code uses this file**

- Before starting any feature, find the line here it delivers. If there is none, it is either a deliberate addition (section 12) or a bonus (section 11). Anything else is scope creep: stop and ask Drix first.
- Tick a box only when the feature is built **and** a test or a manual check proves it. Note the proving test file where useful.
- The brief says the suggested endpoints may be added to but **none may be removed**.

## 1. Product rules

- [ ] Buyers pay into escrow; vendors are paid only when the buyer confirms delivery or a timeout passes.
- [ ] Platform keeps a commission on release; vendors withdraw the rest to a bank account.
- [ ] Disputes freeze funds; admins resolve them and can refund buyers.
- [ ] Two databases with a fixed split: MongoDB for users, profiles, vendor stores, catalogue, reviews, notifications, carts; PostgreSQL for wallets, ledger, orders, payments, escrow, payouts, disputes, refunds.
- [ ] No money value is ever the source of truth in MongoDB.
- [ ] All money is integer kobo (₦1 = 100 kobo). No floats, and no DECIMAL handled as JS floating-point numbers.
- [ ] README section, in Drix's own words: why the split makes sense and what problems came up keeping the two in sync.

## 2. Roles and access

- [ ] Buyer: browse, cart, order, fund wallet, confirm delivery, open disputes, review.
- [ ] Vendor: create store, manage products and stock, view orders, mark shipped, view wallet, request payouts.
- [ ] Admin: approve vendors, view all transactions, resolve disputes, issue refunds, set commission, freeze accounts.
- [x] One user can be both buyer and vendor. ✓ `vendors.admin.test.js`, `cart.test.js`
- [x] RBAC is done with middleware, not role checks scattered in controllers. ✓ `requireRole()`; `rbac.test.js`

## 3. Module A — Authentication and accounts (MongoDB)

- [x] Register with email and password, hashed with bcrypt or argon2. ✓ argon2id; `auth.register.test.js`
- [x] Email verification with an expiring token (console log or Mailtrap is fine). ✓ `auth.register.test.js`
- [x] Login returns a 15-minute access token and a 7-day refresh token. ✓ `auth.login.test.js`
- [x] Refresh tokens stored hashed and rotated on every use. ✓ `auth.sessions.test.js`
- [x] Reusing an old refresh token logs the user out of **all** sessions. ✓ `auth.sessions.test.js`
- [x] Logout invalidates the refresh token. ✓ `auth.sessions.test.js`
- [x] Forgot password and reset password flow. ✓ `auth.password.test.js`
- [x] Login rate limit: at most 5 failed attempts per 15 minutes per email + IP. ✓ `auth.login.test.js`
- [ ] Creating a user in MongoDB creates their wallet in PostgreSQL, with failure handled (section 9). — _PARTIAL: wallet opened at register, left PENDING on failure (`auth.register.test.js`); the reconciler job that retries PENDING wallets comes with Redis/BullMQ_

## 4. Module B — Vendors and products (MongoDB)

- [x] User applies to be a vendor with store name, description and bank details. ✓ `vendors.test.js`
- [x] Application status pending → approved or rejected; only admins decide. ✓ `vendors.admin.test.js`
- [x] Approved vendors create, update and soft-delete products. ✓ `products.test.js`, `products.manage.test.js`
- [x] Product fields: name, unique slug, description, price in kobo, category, image URLs, stock, variants (e.g. size/colour, each with its own price and stock), tags, isActive. ✓ `products.test.js`
- [x] Full-text search on name and description. ✓ `products.list.test.js`
- [x] Filters: category, price range, vendor, rating. ✓ `products.list.test.js`
- [x] Sort: price, newest, rating. ✓ `products.list.test.js`
- [x] Cursor-based pagination (not skip/limit). ✓ `products.list.test.js`
- [ ] Reviews only from buyers with a completed order for that product.
- [ ] One review per buyer per product.
- [ ] Adding a review updates the product's average rating.

## 5. Module C — Cart (MongoDB)

- [x] Add, update and remove items; one cart may hold items from many vendors. ✓ `cart.test.js`
- [ ] At checkout, stock and current price are re-validated (cart prices may be stale).

## 6. Module D — Wallets and ledger (PostgreSQL)

- [x] Every user has a wallet; the platform has system accounts. ✓ `auth.register.test.js`, `ledger.test.js`
- [x] Double-entry: every money movement writes at least one debit and one credit that sum to zero. ✓ `LedgerService.post()`; `ledger.test.js`
- [x] Wallet balance can be derived from the ledger; a cached balance must always equal the ledger sum. ✓ `ledger.test.js`, `audit:ledger`
- [x] Ledger entries are append-only; mistakes are corrected with reversing entries. ✓ DB trigger; `ledger.test.js`
- [x] System accounts exist: `PLATFORM_ESCROW` (buyer money for unfinished orders), `PLATFORM_REVENUE` (commission), `PLATFORM_PAYOUT_CLEARING` (money on its way to a vendor's bank). ✓ `ledger.test.js`
- [ ] At least these tables: `accounts` (id, owner_type, owner_id, currency, balance_kobo, status, created_at), `transactions` (id, unique reference, type, status, unique idempotency_key, JSONB metadata, created_at), `ledger_entries` (id, transaction FK, account FK, direction debit/credit, amount_kobo > 0, created_at), plus `orders`, `order_items`, `payouts`, `disputes`.
- [x] Database constraints refuse bad data even if the code is wrong: amount > 0, user wallet balance ≥ 0, foreign keys, unique keys. ✓ `ledger.test.js` (database guards)

## 7. Module E — Funding the wallet (Paystack test mode)

- [x] Buyer starts funding; the API initialises a Paystack payment and returns the checkout URL. ✓ mock in use; Paystack client unit-tested with faked HTTP (`payments.test.js`); `wallet.fund.test.js`
- [x] Paystack calls a webhook when payment succeeds. ✓ `wallet.webhook.test.js`
- [x] Webhook verifies the HMAC SHA-512 signature with the secret key and rejects anything unsigned or wrongly signed. ✓ required test 5; `wallet.webhook.test.js`
- [x] Webhook is idempotent: duplicate events credit the wallet exactly once. ✓ required test 4; `wallet.webhook.test.js`
- [x] Webhook re-verifies the transaction with Paystack's verify endpoint before crediting. ✓ `wallet.webhook.test.js`
- [x] Allowed alternative: a mock payment provider that behaves the same way, including sending duplicate webhooks. ✓ `/mock-paystack/checkout/:ref/pay`

## 8. Module F — Orders and escrow (PostgreSQL)

- [ ] Checkout takes an `Idempotency-Key` header; the same key never creates two orders.
- [ ] Checkout validates stock and prices against MongoDB.
- [ ] In one PostgreSQL transaction: lock the buyer's wallet row (`SELECT ... FOR UPDATE`), check the balance, create the order and items, move money buyer wallet → `PLATFORM_ESCROW`.
- [ ] A cart with items from N vendors becomes 1 parent order with N sub-orders.
- [ ] Stock is decremented in MongoDB; if that fails, compensate (refund escrow, cancel order). See section 12 for our reserve-first ordering.
- [ ] Only valid state transitions: PENDING_PAYMENT → PAID → SHIPPED → DELIVERED → COMPLETED; PAID → CANCELLED; SHIPPED → DISPUTED; DELIVERED → DISPUTED. Anything else (e.g. PENDING_PAYMENT → COMPLETED, PAID → COMPLETED) is rejected.
- [ ] Vendor marks a sub-order SHIPPED.
- [ ] Buyer confirms DELIVERED.
- [ ] On completion: escrow → vendor wallet (amount minus commission) and escrow → `PLATFORM_REVENUE` (commission, default 5%, admin-configurable).
- [ ] Auto-complete: 72 hours after SHIPPED with no buyer action, the sub-order completes and funds release, run by a scheduled job (node-cron or BullMQ).
- [ ] Buyer can cancel only before SHIPPED; cancelling refunds escrow to the buyer.

## 9. Module G — Disputes and refunds (PostgreSQL)

- [ ] Buyer opens a dispute on a SHIPPED or DELIVERED sub-order, with a reason and evidence (text and/or image URLs).
- [ ] An open dispute freezes that sub-order's escrow; the auto-complete job skips it.
- [ ] Admin resolves as full refund (escrow → buyer), partial refund (part → buyer, rest → vendor, commission only on the vendor's part), or reject (release to vendor as normal).
- [ ] Every resolution records the admin's ID and a note.

## 10. Module H — Vendor payouts (PostgreSQL)

- [ ] Vendor requests a payout; minimum ₦1,000.
- [ ] Money moves vendor wallet → `PLATFORM_PAYOUT_CLEARING` immediately.
- [ ] A background job processes payouts via Paystack Transfer (test mode) or the mock.
- [ ] Success: clearing is cleared, payout marked SUCCESS.
- [ ] Failure: money goes back to the vendor's wallet, payout marked FAILED.
- [ ] At most one PENDING payout per vendor.
- [ ] Two payout requests in the same millisecond cannot withdraw more than the balance (explicitly tested by the marker).

## 11. Module I — Notifications (MongoDB)

- [ ] In-app notifications for: order placed, order shipped, funds released, dispute opened, dispute resolved, payout success, payout failure.
- [ ] `GET /notifications` paginated; mark one read; mark all read; unread count.
- [ ] Notifications are created asynchronously (event emitter or queue); the request does not wait for them.

## 12. Module J — Admin and reporting

- [ ] List and search users; freeze and unfreeze accounts.
- [ ] A frozen user cannot place orders or withdraw.
- [ ] View any wallet and its full ledger history.
- [ ] Reports done in SQL or a query builder, not JavaScript loops:
  - [ ] Platform revenue per day for a date range
  - [ ] Top 10 vendors by completed sales this month
  - [ ] Total money currently in escrow
  - [ ] Reconciliation: wallets whose cached balance differs from their ledger sum (should be empty)

## 13. Non-functional requirements

- [x] Layered architecture: routes → controllers → services → repositories; business logic in services.
- [ ] Every request body and query validated with Joi or Zod. — _PARTIAL: every route so far uses `validate()`; keep it so_
- [x] Central error middleware; error shape `{ success: false, error: { code, message, details } }`.
- [ ] Structured logs (pino or winston) with a request ID on every line.
- [ ] Helmet, CORS config, rate limiting; secrets only in `.env` with a committed `.env.example`; no passwords or tokens in logs. — _PARTIAL: helmet, CORS and login rate limit done; general API rate limiting not yet_
- [ ] Commission rate, escrow timeout and payout minimum are configurable, not hard-coded.
- [x] PostgreSQL schema only through migrations (Knex here); no manual table creation.
- [ ] Seed script: 1 admin, 3 vendors, 20 products, 5 buyers with funded wallets.
- [ ] Swagger/OpenAPI docs served at `/api-docs`.
- [x] `docker-compose up` starts the API, MongoDB, PostgreSQL (and Redis if used). ✓ CI `docker-smoke`
- [x] Tests with Jest and Supertest.

## 14. The hard parts

- [ ] **Cross-database consistency** handled for (a) user created but wallet creation fails and (b) escrow taken but stock decrement fails, using compensating actions or the outbox pattern. README explains the choice and why.
- [ ] **Concurrency:** two simultaneous checkouts by one buyer cannot overspend; two buyers cannot both get the last item. Use row locks, conditional atomic updates in MongoDB, or optimistic locking.
- [ ] **Idempotency:** `POST /orders/checkout`, `POST /wallet/fund` and `POST /payouts` accept `Idempotency-Key`. Same key + same body returns the original response without repeating the action; same key + different body returns 409. — _PARTIAL: middleware done and used by `POST /wallet/fund` (`idempotency.test.js`); checkout and payouts still to wire_
- [x] **Money correctness:** at all times, all user wallets + escrow + revenue + payout clearing = total ever funded − total ever paid out. `npm run audit:ledger` checks it and prints PASS or FAIL. ✓ runs in CI after the suite

## 15. Endpoints (minimum; all under `/api/v1`; none may be removed)

| Area              | Endpoints                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | `POST /auth/register`, `/auth/verify-email`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`                                                                                                                                                             |
| Users, vendors    | `GET /users/me`, `PATCH /users/me`, `POST /vendors/apply`, `GET /vendors/:id`                                                                                                                                                                                                                            |
| Products, reviews | `GET /products`, `GET /products/:slug`, `POST /products` (vendor), `PATCH /products/:id` (vendor), `DELETE /products/:id` (vendor), `POST /products/:id/reviews` (buyer)                                                                                                                                 |
| Cart              | `GET /cart`, `POST /cart/items`, `PATCH /cart/items/:itemId`, `DELETE /cart/items/:itemId`                                                                                                                                                                                                               |
| Wallet            | `GET /wallet`, `GET /wallet/transactions`, `POST /wallet/fund`, `POST /webhooks/paystack`                                                                                                                                                                                                                |
| Orders            | `POST /orders/checkout`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `PATCH /sub-orders/:id/ship` (vendor), `PATCH /sub-orders/:id/confirm` (buyer)                                                                                                                                     |
| Disputes          | `POST /sub-orders/:id/disputes` (buyer), `GET /disputes` (admin), `PATCH /disputes/:id/resolve` (admin)                                                                                                                                                                                                  |
| Payouts           | `POST /payouts` (vendor), `GET /payouts` (vendor)                                                                                                                                                                                                                                                        |
| Notifications     | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`                                                                                                                                                                                                                   |
| Admin             | `GET /admin/users`, `PATCH /admin/users/:id/freeze`, `PATCH /admin/vendors/:id/approve`, `GET /admin/wallets/:id/ledger`, `PATCH /admin/settings/commission`, `GET /admin/reports/revenue?from=&to=`, `GET /admin/reports/top-vendors`, `GET /admin/reports/escrow`, `GET /admin/reports/reconciliation` |

## 16. Required tests (each must exist and pass)

- [x] 1. Login fails before email is verified. ✓ `auth.login.test.js`
- [x] 2. A reused refresh token is rejected and ends all sessions. ✓ `auth.sessions.test.js`
- [x] 3. A buyer cannot reach vendor or admin routes. ✓ `rbac.test.js`
- [x] 4. The same Paystack webhook sent twice credits the wallet once. ✓ `wallet.webhook.test.js`
- [x] 5. A webhook with a bad signature is rejected. ✓ `wallet.webhook.test.js`
- [ ] 6. Checkout with too little balance fails and creates no order and no ledger entries.
- [ ] 7. 10 concurrent checkouts against a wallet that can afford 3 → exactly 3 succeed.
- [ ] 8. 2 buyers racing for the last item → exactly 1 succeeds.
- [ ] 9. The same Idempotency-Key on checkout twice → one order.
- [ ] 10. An invalid transition (e.g. PAID → COMPLETED) is rejected.
- [ ] 11. Completing an order splits money correctly between vendor and platform revenue.
- [ ] 12. The auto-complete job skips a disputed sub-order.
- [ ] 13. A partial refund leaves the ledger balanced.
- [ ] 14. A failed payout returns the money to the vendor's wallet.
- [ ] 15. `npm run audit:ledger` passes after the full test suite.

## 17. Milestones and process

| Week | Expected by the progress check                                            |
| ---- | ------------------------------------------------------------------------- |
| 1    | Setup, Docker, migrations, auth, RBAC, vendors, products (CRUD + search)  |
| 2    | Wallets, double-entry ledger, funding + webhook, cart                     |
| 3    | Checkout, escrow, order state machine, auto-complete job, disputes        |
| 4    | Payouts, notifications, admin reports, tests, Swagger, README, demo video |

- [ ] Short progress check at the end of each week.
- [x] Push to GitHub regularly; one giant final commit is penalised.

## 18. Submission

- [ ] GitHub repo link with a clear folder structure.
- [ ] README with: setup that works with `docker-compose up` + `npm run seed`; an architecture diagram; a PostgreSQL ERD and a description of MongoDB collections; the two-database explanation; how consistency, concurrency and idempotency were handled; known limitations and improvements.
- [x] `.env.example`.
- [ ] Swagger at `/api-docs`.
- [ ] Exported Postman collection (JSON).
- [ ] Test suite runs with `npm test`.
- [ ] 5–10 minute demo video: fund wallet → checkout → ship → confirm → payout, then one dispute.

## 19. Marks

| Area                                                                | Marks |
| ------------------------------------------------------------------- | ----- |
| Auth, RBAC, security                                                | 10    |
| Products, search, pagination, reviews (MongoDB modelling)           | 10    |
| Double-entry ledger and PostgreSQL schema (constraints, migrations) | 15    |
| Wallet funding, webhook verification, idempotency                   | 10    |
| Checkout, escrow, order state machine                               | 15    |
| Concurrency                                                         | 10    |
| Disputes, refunds, payouts                                          | 10    |
| Cross-database consistency                                          | 5     |
| Tests                                                               | 5     |
| Code quality, structure, logging, error handling                    | 5     |
| Documentation, README, Swagger, demo video                          | 5     |

**Automatic deductions:** money stored as floats −10 · ledger rows updated or deleted −10 · secrets committed −5 · project does not start from the README instructions −10.

## 20. Bonus (up to +10; only after every required item and test passes)

- [ ] Redis + BullMQ for all background jobs, with retries and a dead-letter queue
- [ ] Real-time notifications with Socket.io
- [ ] Multi-currency wallets (NGN + USD) with stored exchange rates — **planned skip** (risk to the ledger)
- [ ] Coupons that correctly affect commission — **planned skip**
- [ ] Redis caching of product listings with correct invalidation
- [ ] Deployed with a live URL (Render, Railway, Fly.io)
- [x] CI on every push (GitHub Actions)

## 21. Deliberate additions and interpretations (in scope, explain in README)

These go beyond or interpret the brief on purpose. They are not scope creep, but each needs a line in the README's "Assumptions and design decisions".

- `REFUNDED` sub-order state for a fully refunded dispute.
- `EXTERNAL_PAYSTACK` system account as the counterparty for funding and payouts, so the whole ledger sums to zero.
- Checkout reserves stock first, then takes money (brief's literal order is money first, then stock).
- Shipping requires courier name and tracking number; vendors can reply to a dispute with their own evidence.
- Vendors cannot buy their own products; frozen users can still fund their wallet; rejected vendors may re-apply.
- Commission rate snapshotted per sub-order at checkout.

## 22. Out of scope

- Any frontend or UI (the brief is backend-only; demo through Swagger/Postman).
- Delivery confirmation codes, KYC on bank details, partial shipments, real email sending — "future improvements" in the README only.
