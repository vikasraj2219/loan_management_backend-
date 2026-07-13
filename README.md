# Loan & Interest Management System — Backend

A simple, clean REST API for the Loan & Interest Management System (Node.js + Express + MongoDB).

> **Status: Phase 4 + Pending Monthly Interest Tracking + Manual Interest Backfill + Corrected Interest Math + Document Management on Cloudinary (Archive/Unarchive/Bulk) + Borrower List Prioritization.** Auth, Borrowers (sorted by pending-interest urgency by default), Loans, Payments (receipts on Cloudinary too), per-loan monthly interest automation with historically-accurate principal snapshots and FIFO payment allocation, on-demand backfill/recovery, full CRUD on individual interest records, a secure Cloudinary-backed document repository with archive/restore/bulk operations, Dashboard analytics, and Reports (PDF/Excel/CSV) are all live.

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
cp .env.example .env   # edit JWT secrets + MONGO_URI + Cloudinary credentials
npm run dev             # or: npm start
```

API runs at `http://localhost:5000`.

**Cloudinary setup** (required — document/receipt uploads fail without it): create a free account at [cloudinary.com](https://cloudinary.com), then copy the **Cloud Name**, **API Key**, and **API Secret** from your dashboard into `.env` as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. No further setup on Cloudinary's side is needed — folders (`loan-management/borrowers/`, etc.) are created automatically on first upload.

If you have existing documents/receipts from before this migration, run `npm run migrate:cloudinary` once Cloudinary is configured — see [Document Management](#document-management) for details.

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
| GET | `/borrowers?search=&status=&page=&limit=` | Authenticated | List/search/filter/paginate — **always sorted with pending-interest borrowers first**, see below |
| POST | `/borrowers` | Authenticated | Create borrower |
| GET | `/borrowers/:id` | Authenticated | Get borrower + loans + live interest summary |
| PATCH | `/borrowers/:id` | Authenticated | Update borrower |
| DELETE | `/borrowers/:id` | Admin only | Deactivate (soft delete) |
| GET / POST | `/borrowers/:id/documents` | Authenticated | List / upload documents (multipart, field `files`) — see [Document Management](#document-management) |

**Borrower list ordering is fixed, not user-selectable.** `getBorrowers` no longer accepts a `sort` query param — it runs an aggregation that `$lookup`s each borrower's unpaid `MonthlyInterest` records, computes `pendingMonths` and `pendingInterestAmount` on the fly, and sorts by `{ pendingMonths: -1, pendingInterestAmount: -1, name: 1 }`. Sorting by `pendingMonths` descending alone already achieves the brief's full 4-tier priority (anyone with pending interest naturally sorts above anyone with none, ranked by how many months, then by how much), so it's one sort key doing the work of two priority rules. Both fields are returned on each borrower in the list response for the frontend's badges — nothing is cached, so the order and the numbers are always current as of the request.

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

**One record per loan per calendar month.** The `MonthlyInterest` collection holds a permanent document for every completed month a loan has accrued interest — `{ loan, borrower, month, year, interestAmount, paidAmount, pendingAmount, status, dueDate, paidDate, principalOutstandingAtCharge, interestRateAtCharge }`. `pendingAmount` and `status` (`pending` / `partially_paid` / `paid`) are derived automatically from `interestAmount - paidAmount` in a `pre('save')` hook — nothing ever sets them directly, so they can't drift out of sync. **Records are never merged, edited automatically, or deleted by the system**; an unpaid month just sits there as `pending` forever until a payment clears it.

**The first interest cycle only completes one full month after disbursal — never the issue month itself.** A loan issued 22 June first bills 22 July, not June. `enumerateDuePeriods` in `src/jobs/interestJob.js` starts counting from `loanDate + 1 month` (clamped for short months), and only ever generates a cycle whose due date has actually passed — a due date one day in the future is not generated yet, no matter how close. This is why loan creation (`loanController.createLoan`) no longer eagerly creates an interest record the way earlier versions of this system did.

**Interest for a given month is calculated from the principal outstanding *at that month's due date* — not the loan's current balance.** `principalAsOfDueDate(loan, dueDate)` computes this directly from history: `loanAmount − Σ(principalPaid for every payment made before dueDate)`. Nothing about a later principal payment ever reaches back and changes an earlier month's `interestAmount` — that field is written once, at generation time, from a snapshot of payments that existed *before* that due date, and is never recalculated afterward. A loan of ₹20,000 at 5% bills ₹1,000/month for as long as ₹20,000 is outstanding; the moment a ₹10,000 principal payment lands, every *subsequent* due date correctly bills ₹500 — but every month already generated keeps reading ₹1,000 forever, exactly as it should.

**Payments always clear the oldest unpaid month first — FIFO, no exceptions.** `allocateInterestFifo` (in `src/services/interestAllocationService.js`, shared by payment recording and the backfill reconciliation below) walks a loan's pending `MonthlyInterest` records oldest-first and applies the payment's `interestPaid` across as many as it covers, exactly like the brief's example (Feb + Mar + Apr pending, borrower pays enough for two → Feb and Mar become `paid`, Apr stays `pending`). There is no API for picking which month a payment clears — that's a deliberate constraint, not an oversight. Every allocation is recorded on the `Payment` document itself (`interestAllocations: [{ monthlyInterest, month, year, amountApplied }]`) as a permanent audit trail back to exactly which months a given payment touched.

**Generation runs daily, not monthly, but is a no-op on days nothing is due.** `src/jobs/scheduler.js` (`INTEREST_CRON_HOUR` in `.env`) runs `generateMissingInterestForLoan` for every active/overdue loan every day; because that function only ever creates cycles whose due date has passed, a loan simply gets nothing new on days that aren't its billing anniversary. The unique index on `(loan, periodKey)` — plus a direct existence check before every insert — makes generation fully idempotent.

**Every write that touches interest runs inside a transaction.** `src/utils/withTransaction.js` centralizes the "try a real MongoDB transaction, fall back to sequential writes on a standalone (non-replica-set) `mongod`" pattern used by payment recording, interest generation, manual CRUD on a record, and payment reconciliation — so a crash mid-operation can't leave a loan's totals and its `MonthlyInterest` records out of sync on a properly deployed (replica-set) MongoDB, and degrades gracefully rather than failing outright in local dev.

**Full CRUD on individual records, for the exceptional cases.** `POST/GET/PATCH/DELETE /interest-records` (admin only) lets you view, manually add, edit, or delete a single `MonthlyInterest` record — for data migration, historical entry, or correcting a mistake. Every write immediately recalculates the owning loan's denormalized `totalInterestAccrued`/`totalInterestPaid` from scratch (`recalculateLoanInterestTotals` in `src/services/loanTotalsService.js`, summing the loan's actual records rather than trusting an incremental delta), so a manual edit or delete can never leave the loan, its borrower's Interest Summary, or the dashboard reading a stale number — they all query this collection live anyway.

**Everything is computed live, nothing is trusted from a cache.** Dashboard cards, the borrower's Interest Summary, a loan's Interest Schedule, and every pending/overdue interest report all query `MonthlyInterest` directly at request time. `Loan.totalInterestAccrued`/`totalInterestPaid` exist only as fast denormalized figures for list views — a convenience kept in sync by every write path above, never the source of truth.

### Manual backfill / recovery: `POST /interest/generate`

The daily cron only generates what's due *as of today*. That's a problem for loans that existed before this feature shipped, data migrated from elsewhere, or any stretch of time the cron didn't run — their Interest Summary reads all zeros not because nothing is owed, but because no `MonthlyInterest` records exist yet to say so.

`POST /interest/generate` (admin only) fixes that on demand:

```json
{ "loanId": "optional", "borrowerId": "optional", "generateTill": "optional ISO date, defaults to now" }
```

- No body fields → runs across every active/overdue loan in the system.
- `borrowerId` → scoped to just that borrower's loans.
- `loanId` → scoped to just that one loan.
- For each targeted loan, it walks every completed billing cycle from `loanDate + 1 month` up to `generateTill` and creates whichever ones don't already exist — never touching, merging, or duplicating an existing month, and never generating a cycle whose due date hasn't arrived yet. Each candidate month's interest is computed from the principal outstanding *as of its own due date* (see above), so a backfill run today produces exactly the same numbers a same-day generation would have produced back when each month first came due.
- **Reconciliation step**: if any records were created for a loan, it then re-sweeps that loan's payments (oldest first) that still have leftover `unallocatedInterest` — money paid toward interest before any month existed to absorb it — and re-applies it FIFO against the months that were just backfilled. This is what actually fixes a loan like the one in the bug report: a payment recorded against an empty interest schedule no longer stays permanently stranded once the missing months show up.

Response shape:

```json
{ "totalLoans": 58, "recordsCreated": 412, "duplicatesSkipped": 389, "failed": 0, "interestReconciled": 4200, "errors": [] }
```

Safe to run as often as you like — a second run over the same range reports `recordsCreated: 0` and everything as `duplicatesSkipped`.

### Manual CRUD: `/interest-records`

| Method | Endpoint | Description |
|---|---|---|
| GET | `/interest-records?loan=&borrower=&status=&page=&limit=` | List/filter/paginate individual records |
| GET | `/interest-records/:id` | Get one record |
| POST | `/interest-records` | Manually create a record — `interestAmount`/`principalOutstandingAtCharge` are optional and auto-computed the same way the generator would if omitted |
| PATCH | `/interest-records/:id` | Edit a record (amount, due date, paid amount, remarks) |
| DELETE | `/interest-records/:id` | Delete a record |

All four mutating endpoints recalculate the owning loan's totals before responding — see above.

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

# Manual CRUD on individual records
curl "http://localhost:5000/api/v1/interest-records?loan=<loanId>" \
  -H "Authorization: Bearer <accessToken>"

curl -X POST http://localhost:5000/api/v1/interest-records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"loan":"<loanId>","month":1,"year":2025,"dueDate":"2025-01-22","remarks":"Migrated from old ledger"}'

curl -X PATCH http://localhost:5000/api/v1/interest-records/<recordId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"interestAmount":1200}'

curl -X DELETE http://localhost:5000/api/v1/interest-records/<recordId> \
  -H "Authorization: Bearer <accessToken>"
```

Edge cases to verify:
- `principalPaid` greater than the loan's outstanding principal → `400`
- Recording a payment against a `closed` loan → `400`
- A payment with both `principalPaid` and `interestPaid` at 0 (or omitted) → `400`
- After a payment, `GET /loans/:id` shows updated `principalOutstanding`, `totalPrincipalPaid`, `totalInterestPaid`, and the new payment appears in its `payments` list
- Running `POST /jobs/generate-interest` twice in a row → second run reports `generated: 0, skipped: <n>` (idempotent, no double-charge)
- `POST /jobs/generate-interest` / `check-overdue` as a non-admin → `403`
- `GET /dashboard/summary` numbers reconcile with what you'd expect from the borrowers/loans/payments you created above
- Create a loan, then immediately `GET /loans/:id/interest` → **no** record exists yet (`months: []`) — the first cycle only completes one full month after `loanDate`, never on the issue day itself
- Create three months of pending interest (e.g. via `POST /interest/generate` with a `generateTill` a few months out, or waiting for cron ticks), then pay an amount covering exactly two months' worth of interest → the two oldest months become `paid`, the third stays `pending` (FIFO)
- Pay more interest than is currently pending across all months → the excess shows up as `unallocatedInterest` on the `Payment`, not silently dropped
- A `MonthlyInterest` whose `dueDate` has passed and is still unpaid → counted in `/dashboard/summary`'s `overdueInterestAmount` and shows up in `/reports/overdue-interest`
- **The bug-report scenario**: create a loan, record a payment with `interestPaid > 0` *before* any `MonthlyInterest` record exists for it (simulating a pre-existing loan) → the payment's entire `interestPaid` sits as `unallocatedInterest`. Then run `POST /interest/generate` for that loan → the missing months appear as `pending`/`paid` correctly, and the old payment's `unallocatedInterest` drops (or hits 0) as it gets retroactively applied — `interestReconciled` in the response reflects exactly how much moved
- Run `POST /interest/generate` twice in a row for the same loan → second run reports `recordsCreated: 0`, everything as `duplicatesSkipped`, and `interestReconciled: 0` (nothing left to reconcile)
- `POST /interest/generate` as a non-admin → `403`
- **Historical immutability**: create a ₹20,000 loan at 5%, generate a few months (₹1,000 each), then record a ₹10,000 principal payment, then generate the next month → the new month bills ₹500, but every month generated *before* the payment still reads ₹1,000 — re-fetch them via `GET /interest-records?loan=<loanId>` to confirm they never changed
- Manually create a `MonthlyInterest` record via `POST /interest-records` with `interestAmount` omitted → the response's `principalOutstandingAtCharge` and `interestAmount` are computed the same way the generator would, from payments that existed before that record's `dueDate`
- Edit a record's `interestAmount` via `PATCH /interest-records/:id`, then `GET /loans/:id` → `totalInterestAccrued` reflects the edit immediately (recalculated from all of the loan's records, not incremented)
- Delete a record via `DELETE /interest-records/:id`, then check the loan and dashboard → both totals adjust immediately with no stale leftover
- Attempt `POST /interest-records` with a `month`/`year` that already has a record for that loan → `409 Conflict`

```bash
# Upload two documents to a borrower
curl -X POST http://localhost:5000/api/v1/borrowers/<borrowerId>/documents \
  -H "Authorization: Bearer <accessToken>" \
  -F "category=PAN Card" \
  -F "files=@/path/to/pan.jpg" \
  -F "files=@/path/to/pan-back.jpg"

# List a loan's documents
curl "http://localhost:5000/api/v1/loans/<loanId>/documents" \
  -H "Authorization: Bearer <accessToken>"

# Download (auth required — redirects to a Cloudinary attachment URL)
curl -L "http://localhost:5000/api/v1/documents/download/<documentId>" \
  -H "Authorization: Bearer <accessToken>" -o document.pdf

# Search everything
curl "http://localhost:5000/api/v1/documents?category=Loan%20Agreement&status=active" \
  -H "Authorization: Bearer <accessToken>"

# Archive, then restore
curl -X PATCH "http://localhost:5000/api/v1/borrowers/<borrowerId>/documents/<documentId>/archive" \
  -H "Authorization: Bearer <accessToken>"
curl -X PATCH "http://localhost:5000/api/v1/borrowers/<borrowerId>/documents/<documentId>/unarchive" \
  -H "Authorization: Bearer <accessToken>"

# Bulk archive
curl -X POST http://localhost:5000/api/v1/documents/bulk/archive \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <accessToken>" \
  -d '{"documentIds":["<id1>","<id2>"]}'

# One-time migration of anything still on local disk
npm run migrate:cloudinary
npm run migrate:cloudinary -- --delete-local   # also removes the local files afterward
```

Edge cases to verify:
- Upload a `.exe` (or rename one to `.pdf` and check the `Content-Type` your client sends — the server checks the actual MIME type, not the extension) → `400`
- Upload a file over 20MB → Multer rejects it before it reaches the controller
- Upload a genuinely empty (0 byte) file → `400`, rejected before it reaches Cloudinary
- Upload the same file (same name + size) to the same borrower twice → both succeed, but the second response has `duplicateWarning: true`
- Upload via `/loans/:id/documents` → `GET /borrowers/:borrowerId/documents` for that loan's borrower also shows it (loan documents are borrower-stamped too)
- Archive a document, then `GET .../documents` (default, no `status` param) → it no longer appears; `?status=archived` → it does; `?status=all` → both active and archived appear
- Unarchive a document → it reappears in the default (Active) list; `unarchivedAt`/`unarchivedBy` are set, everything else (upload date, category, etc.) is untouched
- Permanent-delete as a non-admin → `403`; as an admin → the Cloudinary asset and the DB record are both gone, nothing orphaned on either side
- Bulk archive/unarchive/delete with a mix of valid and already-deleted ids → the valid ones succeed, the response's `failed` array explains the rest, and it's a `200` either way (partial success isn't an error)
- Replace a file via `PUT .../documents/:id` with a new `file` field → same `_id`, new `cloudinaryPublicId`/`secureUrl`/`fileSize`, `updatedAt` changes, and the *old* Cloudinary asset is gone (check your Cloudinary media library)
- Run `npm run migrate:cloudinary` against a database with no legacy documents → reports `0 found`, exits cleanly, changes nothing
- `GET /dashboard/summary` → `totalDocuments`, `documentsUploadedToday`, `borrowerDocuments`, `loanDocuments`, `archivedDocuments` all reconcile with what you just created/archived above
- `GET /borrowers` with several borrowers in different pending-interest states → the response order matches `{pendingMonths desc, pendingInterestAmount desc, name asc}`, and each borrower object includes `pendingMonths`/`pendingInterestAmount`; pay off a borrower's last pending month and re-fetch → they drop out of the "has pending interest" group immediately, no caching involved

## Document Management

A dedicated, reusable module — not bolted onto Borrower/Loan — for uploading and managing files against either a borrower, a loan, or both. All new files live in **Cloudinary**; nothing new is written to local disk.

**Ownership model**: every `Document` belongs to a borrower, a loan, or both (enforced by a `pre('validate')` hook — never neither). Uploading through `/loans/:id/documents` automatically stamps the document with that loan's borrower too, so a borrower's own Documents view shows their KYC papers *and* every loan's paperwork in one place, while a loan's view stays strictly scoped to that loan.

**Storage is abstracted from day one — this is what made the Cloudinary migration a two-file change.** Every upload/delete/URL call goes through `src/utils/fileStorage.js`, which itself delegates to `src/services/cloudinaryService.js` (the reusable Cloudinary wrapper — folder resolution, buffer upload, asset deletion, delivery-URL building). Nothing else in the app — not the model, not the controller's business logic, not the frontend — knows or cares that the storage backend changed. Payment receipt uploads (`paymentController.uploadReceipt`) reuse the exact same `fileStorage.uploadFile()` call, per the business rule that the Cloudinary integration should be reusable for other modules.

**Folder structure**: uploads are routed into `loan-management/{borrowers,loans,receipts,agreements,identity-documents,other}/` based on keyword-matching the document's category (`cloudinaryService.resolveFolder`) — e.g. anything with "receipt" in its category goes to `receipts/`, "aadhaar"/"pan card"/"passport"/etc. go to `identity-documents/`, everything else falls back to the owner-type folder (`borrowers/` or `loans/`) or `other/`.

**Legacy documents keep working.** Anything uploaded before this migration has `storageProvider: 'local'` (or predates that field entirely) and a `filePath` — `fileStorage.js` branches on `storageProvider`/`cloudinaryPublicId` presence to fall back to streaming from disk for those, so nothing broke when the storage backend switched. `npm run migrate:cloudinary` (optionally `-- --delete-local` to clean up afterward) is a one-time, safely-re-runnable script that uploads every remaining local document *and* payment receipt to Cloudinary and updates its record — it only ever selects records still missing a `cloudinaryPublicId`, so re-running it is a no-op for anything already migrated.

**Security**: file type is allowlisted by MIME type (PDF, DOC/DOCX, XLS/XLSX, JPG, PNG, WEBP, ZIP) — an allowlist, not a blocklist, is what actually satisfies "prevent executable file uploads." 20MB per file, 0-byte files explicitly rejected. Cloudinary credentials live only in `.env` (`CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`) and are never sent to the frontend — the frontend never talks to Cloudinary directly, only to our own authenticated API. Download and preview both require a valid JWT to reach our endpoint at all; from there, Cloudinary documents get a 302 redirect to a Cloudinary URL (attachment-flagged for downloads, so the original filename survives), while legacy documents still stream from disk.

**Archive is the default "delete."** Archiving (`PATCH .../archive`) never touches the Cloudinary asset — it only flips `status` and stamps `archivedAt`/`archivedBy`, and is fully reversible via `PATCH .../unarchive` (which stamps `unarchivedAt`/`unarchivedBy` and restores nothing else). The default document list (no `status` param) shows Active only; `?status=archived` or `?status=all` opt into seeing archived ones. **Permanent delete** (`?permanent=true` on the DELETE endpoint, or the dedicated bulk-delete route) is admin-only, removes the Cloudinary asset via its `public_id` *and* the DB record — there's never an orphaned Cloudinary file left behind, since the asset is only ever deleted alongside its record, never independently.

**Replace** uploads the new file to Cloudinary first; only once that succeeds does the old asset (Cloudinary or legacy local) get deleted — a failed upload never leaves a document pointing at nothing.

**Bulk operations** (`POST /documents/bulk/{archive,unarchive,delete}`, body `{ documentIds: [] }`) process each id independently, so one bad id in a batch of 50 doesn't abort the other 49 — the response reports exactly which ids succeeded and which failed and why. Bulk delete is admin-only, same as the single-document version.

**Every mutating action is logged** to the generic `ActivityLog` collection (`src/services/activityLogService.js`) — upload, edit, replace, archive, unarchive, both delete flavors, download, and every bulk variant — fire-and-forget, so a logging failure can never block the action it's describing.

### API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET / POST | `/borrowers/:id/documents` | List (filtered/paginated, default Active only) / upload one-or-more files (field `files`, up to 10 per request) |
| GET / PUT / DELETE | `/borrowers/:id/documents/:documentId` | Get one / edit metadata (+ optional file replace via field `file`) / delete (soft by default, `?permanent=true` admin-only) |
| PATCH | `/borrowers/:id/documents/:documentId/archive` , `.../unarchive` | Archive / restore |
| GET / POST | `/loans/:id/documents` | Same shape, scoped to a loan |
| GET / PUT / DELETE / PATCH | `/loans/:id/documents/:documentId[/archive\|/unarchive]` | Same shape, scoped to a loan |
| GET | `/documents` , `/documents/search` | Cross-cutting list/search over every document (borrower/loan/category/status/fileType/date filters; `status=active\|archived\|all`) |
| GET | `/documents/download/:documentId` | Redirects to a Cloudinary attachment URL (or streams legacy local files), preserving the original filename, and increments `downloadCount` |
| GET | `/documents/preview/:documentId` | Redirects to a Cloudinary inline URL (or streams legacy local files) for a browser-native PDF viewer or `<img>` tag |
| GET | `/documents/categories?type=borrower\|loan` | Suggested category list for the upload form's dropdown (free text, not a rigid enum) |
| POST | `/documents/bulk/archive` , `/bulk/unarchive` , `/bulk/delete` | Bulk operations, body `{ documentIds: [] }`; `/bulk/delete` is admin-only |

All routes require authentication; permanent delete (single or bulk) additionally requires the `admin` role.

## This System Is Feature-Complete for a v1
Every feature in the original brief plus the Pending Monthly Interest Tracking, Manual Interest Backfill, Corrected Interest Math, Document Management (now on Cloudinary, with archive/restore and bulk operations), and Borrower List Prioritization addenda is implemented and wired end-to-end: borrower management (surfaced in pending-interest-urgency order automatically), loan creation with principal/interest tracking, partial repayments with a permanent audit trail, monthly interest generation that only fires after a completed billing cycle and is computed from the historically-accurate principal at each due date, FIFO interest payment allocation, on-demand backfill for pre-existing data, full CRUD on individual interest records for exceptional cases, a secure Cloudinary-backed document repository (with preview, tags, download tracking, and reversible archiving) shared correctly between borrowers and loans, transactional writes throughout, dashboard analytics, and exportable reports. Natural v2 candidates beyond this: refresh-token rotation/blacklisting, a notifications/reminders system for upcoming due dates, multi-currency support, Cloudinary's signed/expiring-URL delivery mode for stricter access control than the current redirect-after-auth approach, and role-based UI beyond admin/staff (e.g. read-only auditor).

## License
MIT
