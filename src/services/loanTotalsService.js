const Loan = require('../models/Loan');
const MonthlyInterest = require('../models/MonthlyInterest');

/**
 * Loan.totalInterestAccrued / totalInterestPaid are denormalized figures
 * kept in sync incrementally during normal generation and payment flows
 * (each one just adds the delta it caused). That's fine as long as
 * MonthlyInterest records are only ever created or paid through those
 * flows — but manual CRUD on a record (Requirement 3: admins can create,
 * edit, or delete a MonthlyInterest record directly, for corrections and
 * migration) bypasses those increments entirely. This recalculates both
 * fields from scratch by summing the loan's actual MonthlyInterest
 * records, so a manual edit or delete can never leave the loan's
 * denormalized totals stale (Requirement 8).
 */
async function recalculateLoanInterestTotals(loanId, session) {
  const [agg] = await MonthlyInterest.aggregate([
    { $match: { loan: loanId } },
    { $group: { _id: null, totalAccrued: { $sum: '$interestAmount' }, totalPaid: { $sum: '$paidAmount' } } },
  ]).session(session || null);

  const totalInterestAccrued = agg?.totalAccrued || 0;
  const totalInterestPaid = agg?.totalPaid || 0;

  await Loan.updateOne(
    { _id: loanId },
    { $set: { totalInterestAccrued, totalInterestPaid } },
    { session }
  );

  return { totalInterestAccrued, totalInterestPaid };
}

module.exports = { recalculateLoanInterestTotals };
