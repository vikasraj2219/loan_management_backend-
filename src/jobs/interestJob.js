const Loan = require('../models/Loan');
const MonthlyInterest = require('../models/MonthlyInterest');

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

module.exports = {
  generateInterestForPeriod,
  ensureFirstMonthInterest,
  generateMonthlyInterest,
  markOverdueLoans,
  periodKeyOf,
};
