const MonthlyInterest = require('../models/MonthlyInterest');

/**
 * Applies `interestAmount` to a loan's pending MonthlyInterest records,
 * oldest month first (FIFO) — this is the only allocation rule in the
 * system; there is no way for a user to pick which month a payment clears.
 * Returns { allocations, unallocated } where `allocations` records exactly
 * how much went to which month (for the Payment's audit trail) and
 * `unallocated` is whatever didn't fit into any pending month.
 *
 * Used both when a payment is first recorded (paymentController) and when
 * reconciling old payments against newly backfilled MonthlyInterest
 * records (interestJob's manual generator) — see the comment there for why
 * that reconciliation step exists.
 */
async function allocateInterestFifo(loanId, interestAmount, paidOn, session) {
  const allocations = [];
  let remaining = interestAmount;

  if (remaining <= 0) return { allocations, unallocated: 0 };

  const pendingMonths = await MonthlyInterest.find({
    loan: loanId,
    status: { $in: ['pending', 'partially_paid'] },
  })
    .sort({ year: 1, month: 1 }) // oldest first — FIFO
    .session(session || null);

  for (const monthRecord of pendingMonths) {
    if (remaining <= 0) break;

    const before = monthRecord.pendingAmount;
    if (before <= 0) continue;

    const applied = Math.min(remaining, before);
    monthRecord.paidAmount += applied;
    // pendingAmount/status/paidDate are recalculated by the model's
    // pre('save') hook from interestAmount - paidAmount — never set directly.
    // eslint-disable-next-line no-await-in-loop
    await monthRecord.save({ session });

    allocations.push({
      monthlyInterest: monthRecord._id,
      month: monthRecord.month,
      year: monthRecord.year,
      amountApplied: applied,
    });

    remaining -= applied;
  }

  return { allocations, unallocated: remaining };
}

module.exports = { allocateInterestFifo };
