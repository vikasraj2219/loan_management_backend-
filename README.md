# Loan & Interest Management System — Backend

A simple, clean REST API for the Loan & Interest Management System (Node.js + Express + MongoDB).

> **Status: Phase 2 (Auth + Borrowers + Loans).** Payments, interest automation, dashboard & reports come in later phases.

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

## API Reference (Phase 2)

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

All protected routes need header: `Authorization: Bearer <accessToken>`

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
```

## Roadmap
- **Phase 3** — Payment model, principal/interest payment recording, automatic recalculation of `principalOutstanding`, immutable payment history
- **Phase 4** — Monthly interest cron job, dashboard, reports
- **Phase 5+** — Frontend (React + Vite + MUI)

## License
MIT
