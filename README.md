# Loan & Interest Management System — Backend

A simple, clean REST API for the Loan & Interest Management System (Node.js + Express + MongoDB).

> **Status: Phase 4 — feature-complete for a v1.** Auth, Borrowers, Loans, Payments, monthly interest automation, Dashboard analytics, and Reports (PDF/Excel/CSV) are all live.

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
| GET | `/dashboard/summary` | Borrower/loan counts, total lent, outstanding principal, pending interest, today's/monthly collection |
| GET | `/dashboard/collection-trend?months=6` | Monthly collection totals, zero-filled for months with no activity |
| GET | `/dashboard/principal-interest-trend?months=6` | Principal vs interest collected per month |
| GET | `/dashboard/loan-status-distribution` | Active/closed/overdue counts + percentages |
| GET | `/dashboard/recent-payments?limit=5` | Most recent payments, borrower populated |
| GET | `/dashboard/overdue-loans?limit=5` | Overdue loans with computed `daysOverdue` |
| GET | `/dashboard/top-borrowers?limit=5` | Ranked by total amount lent (aggregation pipeline) |

### Reports
| Method | Endpoint | Description |
|---|---|---|
| GET | `/reports/collections?borrower=&loan=&dateFrom=&dateTo=` | JSON summary + full matching payment list |
| GET | `/reports/export/csv?...` | Same filters, streamed as a `.csv` download |
| GET | `/reports/export/excel?...` | Same filters, streamed as a formatted `.xlsx` workbook (summary + detail sheet) |
| GET | `/reports/export/pdf?...` | Same filters, streamed as a paginated `.pdf` document |

All three export formats and the JSON summary share one filter+fetch function (`fetchReportRows` in `reportController.js`), so a report and its export are always byte-for-byte consistent.

### Jobs (monthly interest automation)
| Method | Endpoint | Access | Description |
|---|---|---|
| POST | `/jobs/generate-interest` | Admin only | Manually run the monthly interest generation for the current period |
| POST | `/jobs/check-overdue` | Admin only | Manually run the overdue-loan check |

**How automation works**: `src/jobs/scheduler.js` registers a `node-cron` schedule (`INTEREST_CRON_DAY`/`INTEREST_CRON_HOUR` in `.env`, default: 1st of the month at 01:00) that calls `generateMonthlyInterest()` then `markOverdueLoans()` from `src/jobs/interestJob.js`. For every active/overdue loan, it creates an `InterestCharge` record (`principalOutstanding × interestRate / 100`) for the current `YYYY-MM` period and adds it to `Loan.totalInterestAccrued`. A unique index on `InterestCharge{loan, periodKey}` makes this **idempotent** — running it twice in the same month (via cron + a manual trigger, or after a missed tick) never double-charges a borrower; the second attempt is simply skipped. The `/jobs/*` endpoints exist so this can be exercised on demand instead of waiting for a real month to pass.

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
```

Edge cases to verify:
- `principalPaid` greater than the loan's outstanding principal → `400`
- Recording a payment against a `closed` loan → `400`
- A payment with both `principalPaid` and `interestPaid` at 0 (or omitted) → `400`
- After a payment, `GET /loans/:id` shows updated `principalOutstanding`, `totalPrincipalPaid`, `totalInterestPaid`, and the new payment appears in its `payments` list
- Running `POST /jobs/generate-interest` twice in a row → second run reports `generated: 0, skipped: <n>` (idempotent, no double-charge)
- `POST /jobs/generate-interest` / `check-overdue` as a non-admin → `403`
- `GET /dashboard/summary` numbers reconcile with what you'd expect from the borrowers/loans/payments you created above

## This System Is Feature-Complete for a v1
Every feature in the original brief is implemented and wired end-to-end: borrower management, loan creation with principal/interest tracking, partial repayments with a permanent audit trail, automatic monthly interest generation, dashboard analytics, and exportable reports. Natural next steps for a v2 would be: refresh-token rotation/blacklisting, a notifications/reminders system for upcoming due dates, multi-currency support, and role-based UI beyond admin/staff (e.g. read-only auditor).

## License
MIT
