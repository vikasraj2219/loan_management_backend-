const Loan = require('../models/Loan');
const InterestCharge = require('../models/InterestCharge');

const currentPeriodKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

/**
 * Generates this month's interest charge for every active loan that
 * doesn't already have one for the current period. Idempotent — safe to
 * run more than once in the same month (the unique index on
 * InterestCharge{loan, periodKey} guarantees no duplicate charge), so a
 * missed cron tick or a manual re-run can never double-charge a borrower.
 *
 * Returns a summary object rather than throwing on a per-loan failure, so
 * one bad loan doesn't stop interest generation for everyone else.
 */
async function generateMonthlyInterest(now = new Date()) {
  const periodKey = currentPeriodKey(now);
  const activeLoans = await Loan.find({ status: { $in: ['active', 'overdue'] } });

  const summary = { periodKey, totalLoans: activeLoans.length, generated: 0, skipped: 0, failed: 0, errors: [] };

  for (const loan of activeLoans) {
    try {
      const amount = Math.round((loan.principalOutstanding * loan.interestRate) / 100);

      if (amount <= 0) {
        summary.skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await InterestCharge.create({
        loan: loan._id,
        borrower: loan.borrower,
        periodKey,
        amount,
        principalOutstandingAtCharge: loan.principalOutstanding,
        interestRateAtCharge: loan.interestRate,
        generatedAt: now,
      });

      loan.totalInterestAccrued += amount;
      loan.lastInterestGeneratedAt = now;
      // eslint-disable-next-line no-await-in-loop
      await loan.save();
      summary.generated += 1;
    } catch (err) {
      if (err.code === 11000) {
        // Already generated for this loan + period — expected on re-run, not an error.
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        summary.errors.push({ loan: loan._id.toString(), message: err.message });
      }
    }
  }

  return summary;
}

/**
 * Flags active loans whose due date has passed as 'overdue'. Loans without
 * a dueDate are never auto-flagged — overdue status only applies when a
 * due date was explicitly set.
 */
async function markOverdueLoans(now = new Date()) {
  const result = await Loan.updateMany(
    { status: 'active', dueDate: { $lt: now } },
    { $set: { status: 'overdue' } }
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

module.exports = { generateMonthlyInterest, markOverdueLoans, currentPeriodKey };
