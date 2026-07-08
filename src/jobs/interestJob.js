const Loan = require('../models/Loan');
const MonthlyInterest = require('../models/MonthlyInterest');
const Payment = require('../models/Payment');
const { allocateInterestFifo } = require('../services/interestAllocationService');
const withTransaction = require('../utils/withTransaction');

const periodKeyOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

const daysInMonth = (year, monthIndex0) => new Date(year, monthIndex0 + 1, 0).getDate();

/**
 * Adds one calendar month to `date`, clamped to that month's own day
 * count (so the 22nd of a 31-day month rolls to the 22nd of a 28-day
 * month, never the 1st of the month after). Used to walk a loan's
 * billing cycle one period at a time.
 */
function addOneMonth(date) {
  const day = date.getDate();
  let year = date.getFullYear();
  let month = date.getMonth() + 1; // moving forward one month, 0-indexed target
  if (month > 11) {
    month = 0;
    year += 1;
  }
  const clampedDay = Math.min(day, daysInMonth(year, month));
  return new Date(year, month, clampedDay);
}

/**
 * The outstanding principal to use for the interest period due on
 * `dueDate` — the loan's original amount minus every principal payment
 * made *before* that due date. This is deliberately NOT the loan's current
 * live `principalOutstanding`: a payment made after this period's due date
 * must never change what this period already owed (see Requirement 5/6 —
 * principal reductions only ever affect *future* interest, and a generated
 * record is permanent once created).
 */
async function principalAsOfDueDate(loan, dueDate) {
  const rows = await Payment.aggregate([
    { $match: { loan: loan._id, paymentDate: { $lt: dueDate } } },
    { $group: { _id: null, totalPrincipalPaid: { $sum: '$principalPaid' } } },
  ]);
  const paidBefore = rows[0]?.totalPrincipalPaid || 0;
  return Math.max(loan.loanAmount - paidBefore, 0);
}

/**
 * Generates a single month's interest record for one loan, for the given
 * `dueDate`. Idempotent — if a record already exists for this (loan, year,
 * month), it's a no-op (returns null). Interest is computed from the
 * outstanding principal *as of dueDate* (see principalAsOfDueDate), not
 * the loan's current balance — this is what makes a historical record
 * correct even when generated well after the fact, and why it never needs
 * to be recalculated later.
 *
 * Wrapped in a transaction (with graceful fallback) since it writes both
 * the MonthlyInterest record and the loan's denormalized
 * totalInterestAccrued in one logical step.
 */
async function generateInterestForPeriod(loan, dueDate) {
  const year = dueDate.getFullYear();
  const month = dueDate.getMonth() + 1; // 1-12

  const principal = await principalAsOfDueDate(loan, dueDate);
  const amount = Math.round((principal * loan.interestRate) / 100);

  if (amount <= 0) return null;

  try {
    return await withTransaction(async (session) => {
      const [record] = await MonthlyInterest.create(
        [
          {
            loan: loan._id,
            borrower: loan.borrower,
            month,
            year,
            periodKey: periodKeyOf(year, month),
            interestAmount: amount,
            paidAmount: 0,
            dueDate,
            principalOutstandingAtCharge: principal,
            interestRateAtCharge: loan.interestRate,
            generatedAt: new Date(),
          },
        ],
        { session }
      );

      loan.totalInterestAccrued += amount;
      loan.lastInterestGeneratedAt = new Date();
      await loan.save({ session });

      return record;
    });
  } catch (err) {
    if (err.code === 11000) return null; // already generated for this period — expected on re-run
    throw err;
  }
}

/**
 * Enumerates every billing period due between a loan's first interest
 * cycle and `generateTill`, inclusive. The FIRST due date is exactly one
 * month after loanDate — a loan issued 22 Jun bills first on 22 Jul, never
 * on the issue date itself, since interest for a cycle is only owed once
 * that cycle is complete (Requirement 1). Each subsequent period is one
 * more month on from there, clamped for short months. Stops as soon as a
 * period's due date would fall after `generateTill`, so this never
 * generates a cycle that hasn't finished yet (Requirement 2).
 */
function enumerateDuePeriods(loanDate, generateTill) {
  const periods = [];
  let cursor = addOneMonth(loanDate);

  // Safety cap so a bad date can never spin this into an infinite loop.
  for (let i = 0; i < 1200; i += 1) {
    if (cursor > generateTill) break;
    periods.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1, dueDate: cursor });
    cursor = addOneMonth(cursor);
  }

  return periods;
}

/**
 * After generating any new months for a loan, sweeps that loan's payments
 * (oldest first) that still have leftover `unallocatedInterest` — money
 * paid toward interest before any MonthlyInterest record existed to
 * absorb it — and re-applies that leftover FIFO against the months that
 * were just created. Without this, a payment made before this feature (or
 * before a given month's cycle had even completed) would stay permanently
 * unallocated even after the record it should pay off shows up. Never
 * touches a payment's principalPaid/interestPaid — only its
 * unallocatedInterest and interestAllocations audit trail move, and each
 * payment's reallocation is one transaction.
 */
async function reconcilePaymentsAgainstBackfilledMonths(loanId) {
  const payments = await Payment.find({ loan: loanId, unallocatedInterest: { $gt: 0 } }).sort({ paymentDate: 1 });

  let totalReconciled = 0;
  for (const payment of payments) {
    // eslint-disable-next-line no-await-in-loop
    const applied = await withTransaction(async (session) => {
      const { allocations, unallocated } = await allocateInterestFifo(loanId, payment.unallocatedInterest, payment.paymentDate, session);
      if (allocations.length === 0) return 0;

      const before = payment.unallocatedInterest;
      payment.interestAllocations.push(...allocations);
      payment.unallocatedInterest = unallocated;
      await payment.save({ session });
      return before - unallocated;
    });
    totalReconciled += applied;
  }

  return totalReconciled;
}

/**
 * Generates every missing MonthlyInterest record for one loan, from its
 * first completed billing cycle up to `generateTill` (default: now). This
 * is the shared core used by both the daily cron (generateTill = today)
 * and the manual backfill endpoint (generateTill = any date, any scope) —
 * they're the same operation at different scopes, so there's exactly one
 * implementation of "what counts as due" to keep in sync.
 * Duplicate-safe: existing months are detected and skipped, never
 * overwritten (checked directly rather than relying solely on the unique
 * index, so the summary's duplicatesSkipped count is accurate).
 */
async function generateMissingInterestForLoan(loan, generateTill) {
  const periods = enumerateDuePeriods(new Date(loan.loanDate), generateTill);

  let recordsCreated = 0;
  let duplicatesSkipped = 0;
  let failed = 0;
  const errors = [];

  for (const period of periods) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const exists = await MonthlyInterest.exists({ loan: loan._id, year: period.year, month: period.month });
      if (exists) {
        duplicatesSkipped += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const record = await generateInterestForPeriod(loan, period.dueDate);
      if (record) recordsCreated += 1;
      else duplicatesSkipped += 1; // race with another request, or amount was 0
    } catch (err) {
      failed += 1;
      errors.push({ loan: loan._id.toString(), period: periodKeyOf(period.year, period.month), message: err.message });
    }
  }

  let interestReconciled = 0;
  if (recordsCreated > 0) {
    try {
      interestReconciled = await reconcilePaymentsAgainstBackfilledMonths(loan._id);
    } catch (err) {
      errors.push({ loan: loan._id.toString(), period: 'reconciliation', message: err.message });
    }
  }

  return { recordsCreated, duplicatesSkipped, failed, errors, interestReconciled };
}

/**
 * Daily cron entry point: generates every due-but-missing month, up to
 * today, for every active/overdue loan. Because generateMissingInterestForLoan
 * only ever creates periods whose due date has actually passed, running
 * this daily naturally produces "generate on each loan's own billing day"
 * behavior without needing to special-case "is today the billing day" —
 * a loan simply gets nothing new on the days nothing is due yet.
 */
async function generateMonthlyInterest(now = new Date()) {
  const loans = await Loan.find({ status: { $in: ['active', 'overdue'] } });

  const summary = {
    date: now.toISOString().slice(0, 10),
    totalLoans: loans.length,
    generated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const loan of loans) {
    // eslint-disable-next-line no-await-in-loop
    const result = await generateMissingInterestForLoan(loan, now);
    summary.generated += result.recordsCreated;
    summary.skipped += result.duplicatesSkipped;
    summary.failed += result.failed;
    summary.errors.push(...result.errors);
  }

  return summary;
}

/**
 * Flags active loans whose own due date has passed as 'overdue'. This is
 * about the loan's overall due date/tenure, distinct from per-month
 * "overdue interest" (an unpaid MonthlyInterest whose dueDate has passed),
 * which is tracked separately — see dashboardController's overdue-interest
 * cards, which query MonthlyInterest directly rather than Loan.status.
 */
async function markOverdueLoans(now = new Date()) {
  const result = await Loan.updateMany({ status: 'active', dueDate: { $lt: now } }, { $set: { status: 'overdue' } });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/**
 * The manual trigger behind POST /api/v1/interest/generate. Scopes to a
 * single loan, a single borrower's loans, or every active/overdue loan in
 * the system, and backfills each one up to `generateTill` (default now).
 * Closed loans are always excluded — interest shouldn't keep accruing
 * after a loan is closed, even if explicitly targeted by id.
 */
async function generateInterestRecordsBulk({ loanId, borrowerId, generateTill } = {}) {
  const till = generateTill ? new Date(generateTill) : new Date();

  const filter = { status: { $in: ['active', 'overdue'] } };
  if (loanId) filter._id = loanId;
  if (borrowerId) filter.borrower = borrowerId;

  const loans = await Loan.find(filter);

  const summary = {
    generateTill: till.toISOString(),
    totalLoans: loans.length,
    recordsCreated: 0,
    duplicatesSkipped: 0,
    failed: 0,
    interestReconciled: 0,
    errors: [],
  };

  for (const loan of loans) {
    // eslint-disable-next-line no-await-in-loop
    const result = await generateMissingInterestForLoan(loan, till);
    summary.recordsCreated += result.recordsCreated;
    summary.duplicatesSkipped += result.duplicatesSkipped;
    summary.failed += result.failed;
    summary.interestReconciled += result.interestReconciled;
    summary.errors.push(...result.errors);
  }

  return summary;
}

module.exports = {
  generateInterestForPeriod,
  generateMissingInterestForLoan,
  generateMonthlyInterest,
  markOverdueLoans,
  periodKeyOf,
  enumerateDuePeriods,
  principalAsOfDueDate,
  generateInterestRecordsBulk,
};
