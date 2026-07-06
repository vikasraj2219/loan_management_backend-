const Loan = require('../models/Loan');
const MonthlyInterest = require('../models/MonthlyInterest');
const Payment = require('../models/Payment');
const { allocateInterestFifo } = require('../services/interestAllocationService');

const periodKeyOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

const daysInMonth = (year, monthIndex0) => new Date(year, monthIndex0 + 1, 0).getDate();

/**
 * Generates a single month's interest record for one loan, for the given
 * `periodDate` (whose year/month determine the period, and whose day
 * becomes the record's dueDate). Idempotent — if a record already exists
 * for this (loan, year, month), it's a no-op (returns null), so this is
 * safe to call from both loan creation and the daily cron without ever
 * double-charging.
 *
 * Does NOT touch any other month's record — previous unpaid months are
 * left exactly as they are, which is what "carries forward" pending
 * interest means in this system: nothing merges, nothing gets overwritten.
 */
async function generateInterestForPeriod(loan, periodDate) {
  const year = periodDate.getFullYear();
  const month = periodDate.getMonth() + 1; // 1-12
  const amount = Math.round((loan.principalOutstanding * loan.interestRate) / 100);

  if (amount <= 0) return null;

  try {
    const record = await MonthlyInterest.create({
      loan: loan._id,
      borrower: loan.borrower,
      month,
      year,
      periodKey: periodKeyOf(year, month),
      interestAmount: amount,
      paidAmount: 0,
      dueDate: periodDate,
      principalOutstandingAtCharge: loan.principalOutstanding,
      interestRateAtCharge: loan.interestRate,
      generatedAt: new Date(),
    });

    loan.totalInterestAccrued += amount;
    loan.lastInterestGeneratedAt = new Date();
    await loan.save();

    return record;
  } catch (err) {
    if (err.code === 11000) return null; // already generated for this period — expected on re-run
    throw err;
  }
}

/**
 * Generates the very first month's interest record immediately when a
 * loan is created, for the calendar month of loanDate itself — this is
 * why a loan disbursed in January already shows a January interest row
 * (see the brief's example table) instead of waiting for the first
 * anniversary. Called once from loanController.createLoan.
 */
async function ensureFirstMonthInterest(loan) {
  return generateInterestForPeriod(loan, loan.loanDate);
}

/**
 * Daily job: for every active/overdue loan, checks whether *today* is
 * that loan's "money taken day" — the day-of-month of its own loanDate,
 * clamped to the days actually in the current month (so a loan disbursed
 * on the 31st still bills on the 28th/30th in shorter months) — and if so,
 * generates that month's interest record. Each loan bills on its own
 * anniversary day, not a single fixed date for the whole system.
 *
 * The origination month itself is skipped here since ensureFirstMonthInterest
 * already created it at loan-creation time; this only ever generates
 * month 2 onward. Safe to run more than once a day or after a missed day —
 * the unique (loan, year, month) index on MonthlyInterest makes it a no-op
 * for anything already generated.
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
    try {
      const originDay = new Date(loan.loanDate).getDate();
      const billingDay = Math.min(originDay, daysInMonth(now.getFullYear(), now.getMonth()));

      const isOriginationMonth =
        now.getFullYear() === new Date(loan.loanDate).getFullYear() &&
        now.getMonth() === new Date(loan.loanDate).getMonth();

      if (isOriginationMonth || now.getDate() < billingDay) {
        summary.skipped += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      const periodDate = new Date(now.getFullYear(), now.getMonth(), billingDay);
      // eslint-disable-next-line no-await-in-loop
      const record = await generateInterestForPeriod(loan, periodDate);
      if (record) summary.generated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ loan: loan._id.toString(), message: err.message });
    }
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
 * Enumerates every billing period (one per calendar month) between a
 * loan's disbursal date and `generateTill`, inclusive — each period's
 * `periodDate` is that loan's own billing day for that month (clamped for
 * short months), matching the logic in generateMonthlyInterest(). Stops
 * as soon as a period's billing day would fall after `generateTill`, so
 * this never generates a month that isn't due yet.
 */
function enumerateBillingPeriods(loanDate, generateTill) {
  const periods = [];
  const originDay = loanDate.getDate();
  let cursorYear = loanDate.getFullYear();
  let cursorMonth = loanDate.getMonth(); // 0-indexed

  // Safety cap so a bad date can never spin this into an infinite loop.
  for (let i = 0; i < 1200; i += 1) {
    const billingDay = Math.min(originDay, daysInMonth(cursorYear, cursorMonth));
    const periodDate = new Date(cursorYear, cursorMonth, billingDay);
    if (periodDate > generateTill) break;

    periods.push({ year: cursorYear, month: cursorMonth + 1, periodDate });

    cursorMonth += 1;
    if (cursorMonth > 11) {
      cursorMonth = 0;
      cursorYear += 1;
    }
  }

  return periods;
}

/**
 * After backfilling missing months for a loan, sweeps that loan's
 * payments (oldest first) that still have leftover `unallocatedInterest`
 * — money that was paid toward interest before any MonthlyInterest record
 * existed to absorb it — and re-applies that leftover FIFO against the
 * months that were just created. This is what makes "recovering missing
 * monthly records" actually fix a loan's Interest Summary: without it, a
 * payment made before this feature ever ran would stay permanently
 * unallocated even after the records it should have paid off show up.
 * Never touches a payment's principalPaid/interestPaid — only its
 * unallocatedInterest and interestAllocations audit trail move.
 */
async function reconcilePaymentsAgainstBackfilledMonths(loanId) {
  const payments = await Payment.find({ loan: loanId, unallocatedInterest: { $gt: 0 } }).sort({ paymentDate: 1 });

  let totalReconciled = 0;
  for (const payment of payments) {
    // eslint-disable-next-line no-await-in-loop
    const { allocations, unallocated } = await allocateInterestFifo(loanId, payment.unallocatedInterest, payment.paymentDate, null);
    if (allocations.length > 0) {
      totalReconciled += payment.unallocatedInterest - unallocated;
      payment.interestAllocations.push(...allocations);
      payment.unallocatedInterest = unallocated;
      // eslint-disable-next-line no-await-in-loop
      await payment.save();
    }
  }

  return totalReconciled;
}

/**
 * Generates every missing MonthlyInterest record for one loan, from its
 * disbursal date up to `generateTill` (default: now) — not just "this
 * month" like the daily cron. This is the manual backfill entry point for:
 * initial setup, loans that existed before this feature shipped, data
 * migration, and recovering from a period where the cron didn't run.
 * Duplicate-safe: existing months are detected and skipped, never
 * overwritten (checked directly rather than relying solely on the unique
 * index, so the summary's duplicatesSkipped count is accurate).
 */
async function backfillLoanInterest(loan, generateTill) {
  const periods = enumerateBillingPeriods(new Date(loan.loanDate), generateTill);

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
      const record = await generateInterestForPeriod(loan, period.periodDate);
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
    const result = await backfillLoanInterest(loan, till);
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
  ensureFirstMonthInterest,
  generateMonthlyInterest,
  markOverdueLoans,
  periodKeyOf,
  enumerateBillingPeriods,
  backfillLoanInterest,
  generateInterestRecordsBulk,
};
