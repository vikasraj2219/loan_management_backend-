# Loan & Interest Management System — Backend

A simple, clean REST API for the Loan & Interest Management System (Node.js + Express + MongoDB).

> **Status: Phase 4 + Pending Monthly Interest Tracking + Manual Interest Backfill.** Auth, Borrowers, Loans, Payments, per-loan monthly interest automation with FIFO payment allocation, an on-demand backfill/recovery generator, Dashboard analytics, and Reports (PDF/Excel/CSV) are all live.

## Tech Stack
- Node.js + Express
- MongoDB + Mongoose
- JWT auth (access + refresh tokens), bcryptjs
- express-validator for validation
- Multer for file uploads
- Morgan for basic request logging

## Folder Structure
```
loan-management-backend/
├── src/
│   ├── config/          # db.js — MongoDB connection
│   ├── controllers/     # request handlers
│   ├── middlewares/     # auth, validation, error handling, upload
│   ├── models/          # Mongoose schemas
│   ├── routes/          # Express routers
│   ├── utils/           # ApiError, ApiResponse, catchAsync, pagination, JWT helpers, seed script
│   ├── validators/      # express-validator rule sets
│   ├── app.js           # Express app setup
│   └── server.js        # entry point
├── uploads/              # uploaded KYC documents
└── package.json
```

Config is read directly from `process.env` (loaded via `dotenv` in `server.js`) — no extra config-validation layer.

## Getting Started

```bash
cd loan-management-backend
npm install
cp .env.example .env   # edit JWT secrets + MONGO_URI
npm run dev             # or: npm start
```

API runs at `http://localhost:5000`.

Optional: seed a default admin user:
```bash
npm run seed
```
(Or just call `POST /auth/register` — the first user created automatically becomes admin.)

## API Reference (Phase 4)

Base URL: `http://localhost:5000/api/v1`

### Auth
| Method | Endpoint | Access | Description |
|---|---|---|---|
| POST | `/auth/register` | Public | Register (first user → admin) |
| POST | `/auth/login` | Public | Login, returns access + refresh token |
| POST | `/auth/refresh` | Public | Get new access token |
| GET | `/auth/me` | Authenticated | Current user profile |
| PATCH | `/auth/update-password` | Authenticated | Change password |

### Borrowers
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/borrowers?search=&status=&page=&limit=` | Authenticated | List/search/filter/paginate |
| POST | `/borrowers` | Authenticated | Create borrower |
| GET | `/borrowers/:id` | Authenticated | Get borrower + loans |
| PATCH | `/borrowers/:id` | Authenticated | Update borrower |
| DELETE | `/borrowers/:id` | Admin only | Deactivate (soft delete) |
| POST | `/borrowers/:id/documents` | Authenticated | Upload KYC docs (multipart, field `documents`) |

### Loans
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/loans?status=&borrower=&minAmount=&maxAmount=&minRate=&maxRate=&page=&limit=` | Authenticated | List/filter/paginate loans (borrower populated) |
| POST | `/loans` | Authenticated | Create a loan for an active borrower |
| GET | `/loans/:id` | Authenticated | Get a single loan |
| PATCH | `/loans/:id` | Authenticated | Update loan metadata (interest rate, tenure, due date, notes) — **not** principal |
| PATCH | `/loans/:id/close` | Authenticated | Close a loan once `principalOutstanding` is 0 |
| PATCH | `/loans/:id/mark-overdue` | Admin only | Manually flag a loan as overdue |

**Loan logic**: `principalOutstanding` starts equal to `loanAmount` and is only ever reduced by recorded payments (Phase 3) — it's never editable directly via `PATCH`, so the audit trail always reconciles. `currentMonthlyInterest` is a virtual computed on demand as `principalOutstanding × interestRate / 100`, so it's always correct even if the rate or outstanding balance changes — nothing stale is stored.

### Payments
| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/payments?loan=&borrower=&paymentMode=&dateFrom=&dateTo=&page=&limit=` | Authenticated | List/filter/paginate payments, most recent first |
| POST | `/payments` | Authenticated | Record a principal and/or interest payment against a loan |
| GET | `/payments/:id` | Authenticated | Get a single payment |
| PATCH | `/payments/:id` | Authenticated | Update metadata only (mode, reference number, remarks) |
| POST | `/payments/:id/receipt` | Authenticated | Upload a receipt file (multipart, field `receipt`) |

**Payment logic — the permanent ledger**: recording a payment is the *only* way `Loan.principalOutstanding` changes. Every payment is validated so `principalPaid` never exceeds the loan's current outstanding principal, and rejected outright against a `closed` loan. Once written, `principalPaid`/`interestPaid` are immutable — `PATCH` only touches non-financial fields — so payment history can never be silently rewritten. Each payment also stores a `principalOutstandingAfter` snapshot, so historical statements read correctly even as the loan evolves further. Where the database supports it, the payment insert and loan balance update commit as a single transaction; the code falls back to sequential writes on a non-replica-set MongoDB (the common local-dev setup) — see the comment in `paymentController.js` for details.

All protected routes need header: `Authorization: Bearer <accessToken>`

### Dashboard
| Method | Endpoint | Description |
|---|---|---|
| GET | `/dashboard/summary` | Borrower/loan counts, totals, collections, **plus Pending Interest Tracking cards** — see below |
| GET | `/dashboard/collection-trend?months=6` | Monthly collection totals, zero-filled for months with no activity |
| GET | `/dashboard/principal-interest-trend?months=6` | Principal vs interest collected per month |
| GET | `/dashboard/loan-status-distribution` | Active/closed/overdue counts + percentages |
| GET | `/dashboard/recent-payments?limit=5` | Most recent payments, borrower populated |
| GET | `/dashboard/overdue-loans?limit=5` | Overdue loans with computed `daysOverdue` |
| GET | `/dashboard/top-borrowers?limit=5` | Ranked by total amount lent (aggregation pipeline) |

`/dashboard/summary` includes five fields computed live from the `MonthlyInterest` collection on every request (never cached): `totalPendingInterest`, `totalPendingInterestMonths`, `borrowersWithPendingInterest`, `overdueInterestAmount`, `loansWithOverdueInterest`.

### Reports
| Method | Endpoint | Description |
|---|---|---|
| GET | `/reports/collections?borrower=&loan=&dateFrom=&dateTo=` | JSON summary + full matching payment list |
| GET | `/reports/export/csv?...` | Same filters, streamed as a `.csv` download |
| GET | `/reports/export/excel?...` | Same filters, streamed as a formatted `.xlsx` workbook (summary + detail sheet) |
| GET | `/reports/export/pdf?...` | Same filters, streamed as a paginated `.pdf` document |
| GET | `/reports/pending-interest?borrower=&loan=&minPendingMonths=&status=` | Borrowers/months with pending interest + summary totals |
| GET | `/reports/overdue-interest?borrower=&loan=&dateFrom=` | Pending months whose due date has already passed, with `daysOverdue` |
| GET | `/reports/interest-collection-history?months=6` | Interest **generated** (from `MonthlyInterest`) vs interest **collected** (from `Payment`), per month — two different timelines shown side by side |
| GET | `/reports/export/pending-interest/csv?...` | Pending interest report as a `.csv` download |

All collection export formats and the JSON summary share one filter+fetch function (`fetchReportRows` in `reportController.js`), so a report and its export are always byte-for-byte consistent.

### Jobs (interest automation)
| Method | Endpoint | Access | Description |
|---|---|---|
| POST | `/jobs/generate-interest` | Admin only | Manually run the daily interest check for every loan right now |
| POST | `/jobs/check-overdue` | Admin only | Manually run the overdue-loan check |

## Pending Monthly Interest Tracking

This is the core domain model of the system, so it's worth explaining in full.

**One record per loan per calendar month.** The `MonthlyInterest` collection holds a permanent document for every month a loan has been active — `{ loan, borrower, month, year, interestAmount, paidAmount, pendingAmount, status, dueDate, paidDate }`. `pendingAmount` and `status` (`pending` / `partially_paid` / `paid`) are derived automatically from `interestAmount - paidAmount` in a `pre('save')` hook — nothing ever sets them directly, so they can't drift out of sync. **Records are never merged, edited, or deleted**; an unpaid month just sits there as `pending` forever until a payment clears it.

**Generation happens on each loan's own "money taken day".** Rather than one fixed date for the whole system, `src/jobs/interestJob.js` runs a check **daily** (`src/jobs/scheduler.js`, `INTEREST_CRON_HOUR` in `.env`) and, for every active/overdue loan, asks: *is today this loan's billing anniversary — the day-of-month it was disbursed?* If so, and no record exists yet for the current month, it generates one (`principalOutstanding × interestRate / 100`, clamped for short months so a loan disbursed on the 31st still bills on the 28th/30th). The loan's **first** month is generated immediately at loan creation (`ensureFirstMonthInterest`, called from `loanController.createLoan`) rather than waiting for a cron tick, since the brief's example table starts counting from the disbursal month. A unique index on `(loan, year, month)` makes every generation idempotent.

**Payments always clear the oldest unpaid month first — FIFO, no exceptions.** `allocateInterestFifo` (in `src/services/interestAllocationService.js`, shared by payment recording and the backfill reconciliation below) walks a loan's pending `MonthlyInterest` records oldest-first and applies the payment's `interestPaid` across as many as it covers, exactly like the brief's example (Feb + Mar + Apr pending, borrower pays enough for two → Feb and Mar become `paid`, Apr stays `pending`). There is no API for picking which month a payment clears — that's a deliberate constraint, not an oversight. Every allocation is recorded on the `Payment` document itself (`interestAllocations: [{ monthlyInterest, month, year, amountApplied }]`) as a permanent audit trail back to exactly which months a given payment touched.

**Everything is computed live, nothing is trusted from a cache.** Dashboard cards, the borrower's Interest Summary, a loan's Interest Schedule, and every pending/overdue interest report all query `MonthlyInterest` directly at request time. (`Loan.totalInterestAccrued`/`totalInterestPaid` still exist as fast denormalized figures for list views, but they're a convenience, not the source of truth.)

### Manual backfill / recovery: `POST /interest/generate`

The daily cron only ever generates *today's* billing charge for loans whose anniversary is today. That's a problem for loans that existed before this feature shipped, data migrated from elsewhere, or any stretch of time the cron didn't run — their Interest Summary reads all zeros not because nothing is owed, but because no `MonthlyInterest` records exist yet to say so.

`POST /interest/generate` (admin only) fixes that on demand:

```json
{ "loanId": "optional", "borrowerId": "optional", "generateTill": "optional ISO date, defaults to now" }
```

- No body fields → runs across every active/overdue loan in the system.
- `borrowerId` → scoped to just that borrower's loans.
- `loanId` → scoped to just that one loan.
- For each targeted loan, it walks every billing period from `loanDate` up to `generateTill` and creates whichever ones don't already exist — never touching, merging, or duplicating an existing month. It's checked directly (`MonthlyInterest.exists(...)`) rather than relying solely on the unique index, so the response's `duplicatesSkipped` count is exact.
- **Reconciliation step**: if any records were created for a loan, it then re-sweeps that loan's payments (oldest first) that still have leftover `unallocatedInterest` — money paid toward interest before any month existed to absorb it — and re-applies it FIFO against the months that were just backfilled. This is what actually fixes a loan like the one in the bug report: a payment recorded against an empty interest schedule no longer stays permanently stranded once the missing months show up.

Response shape:

```json
{ "totalLoans": 58, "recordsCreated": 412, "duplicatesSkipped": 389, "failed": 0, "interestReconciled": 4200, "errors": [] }
```

Safe to run as often as you like — a second run over the same range reports `recordsCreated: 0` and everything as `duplicatesSkipped`.

## Quick Test

```bash
curl -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@test.com","password":"Admin@1234"}'

curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Admin@1234"}'

curl -X POST http://localhost:5000/api/v1/borrowers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"name":"Ravi Kumar","phone":"9876543210"}'
# copy the borrower _id from the response

curl -X POST http://localhost:5000/api/v1/loans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"borrower":"<borrowerId>","loanAmount":50000,"interestRate":2,"loanDate":"2026-01-01"}'

curl "http://localhost:5000/api/v1/loans?status=active" \
  -H "Authorization: Bearer <accessToken>"
# copy the loan _id from the response

curl -X POST http://localhost:5000/api/v1/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"loan":"<loanId>","principalPaid":20000,"interestPaid":1000,"paymentMode":"cash"}'

curl "http://localhost:5000/api/v1/payments?loan=<loanId>" \
  -H "Authorization: Bearer <accessToken>"

curl -X POST http://localhost:5000/api/v1/jobs/generate-interest \
  -H "Authorization: Bearer <accessToken>"

curl "http://localhost:5000/api/v1/dashboard/summary" \
  -H "Authorization: Bearer <accessToken>"

curl "http://localhost:5000/api/v1/reports/export/csv" \
  -H "Authorization: Bearer <accessToken>" -o report.csv

curl "http://localhost:5000/api/v1/loans/<loanId>/interest" \
  -H "Authorization: Bearer <accessToken>"

curl "http://localhost:5000/api/v1/reports/pending-interest" \
  -H "Authorization: Bearer <accessToken>"

curl "http://localhost:5000/api/v1/reports/overdue-interest" \
  -H "Authorization: Bearer <accessToken>"

# Backfill every missing month for one loan (e.g. a loan created before
# this feature existed, exactly the scenario in the bug report)
curl -X POST http://localhost:5000/api/v1/interest/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"loanId":"<loanId>"}'

# Backfill everything, system-wide, up to a specific date
curl -X POST http://localhost:5000/api/v1/interest/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"generateTill":"2026-07-01"}'
```

Edge cases to verify:
- `principalPaid` greater than the loan's outstanding principal → `400`
- Recording a payment against a `closed` loan → `400`
- A payment with both `principalPaid` and `interestPaid` at 0 (or omitted) → `400`
- After a payment, `GET /loans/:id` shows updated `principalOutstanding`, `totalPrincipalPaid`, `totalInterestPaid`, and the new payment appears in its `payments` list
- Running `POST /jobs/generate-interest` twice in a row → second run reports `generated: 0, skipped: <n>` (idempotent, no double-charge)
- `POST /jobs/generate-interest` / `check-overdue` as a non-admin → `403`
- `GET /dashboard/summary` numbers reconcile with what you'd expect from the borrowers/loans/payments you created above
- Create a loan, then immediately `GET /loans/:id/interest` → the disbursal month's `MonthlyInterest` record already exists with `status: 'pending'`
- Create three months of pending interest (e.g. by backdating test data or waiting for cron ticks), then pay an amount covering exactly two months' worth of interest → the two oldest months become `paid`, the third stays `pending` (FIFO)
- Pay more interest than is currently pending across all months → the excess shows up as `unallocatedInterest` on the `Payment`, not silently dropped
- A `MonthlyInterest` whose `dueDate` has passed and is still unpaid → counted in `/dashboard/summary`'s `overdueInterestAmount` and shows up in `/reports/overdue-interest`
- **The bug-report scenario**: create a loan, record a payment with `interestPaid > 0` *before* any `MonthlyInterest` record exists for it (simulating a pre-existing loan) → the payment's entire `interestPaid` sits as `unallocatedInterest`. Then run `POST /interest/generate` for that loan → the missing months appear as `pending`/`paid` correctly, and the old payment's `unallocatedInterest` drops (or hits 0) as it gets retroactively applied — `interestReconciled` in the response reflects exactly how much moved
- Run `POST /interest/generate` twice in a row for the same loan → second run reports `recordsCreated: 0`, everything as `duplicatesSkipped`, and `interestReconciled: 0` (nothing left to reconcile)
- `POST /interest/generate` as a non-admin → `403`

## This System Is Feature-Complete for a v1
Every feature in the original brief plus the Pending Monthly Interest Tracking and Manual Interest Backfill addenda is implemented and wired end-to-end: borrower management, loan creation with principal/interest tracking, partial repayments with a permanent audit trail, per-loan monthly interest generation on each borrower's own billing day, FIFO interest payment allocation, on-demand backfill for pre-existing data, dashboard analytics, and exportable reports. Natural next steps for a v2 would be: refresh-token rotation/blacklisting, a notifications/reminders system for upcoming due dates, multi-currency support, and role-based UI beyond admin/staff (e.g. read-only auditor).

## License
MIT
