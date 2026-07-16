const MonthlyInterest = require('../models/MonthlyInterest');
const Payment = require('../models/Payment');

/**
 * Undoes everything a payment did to a loan: subtracts its
 * interestAllocations back off every MonthlyInterest record it touched
 * (including anything allocated later by the backfill reconciliation job
 * — see interestJob.reconcilePaymentsAgainstBackfilledMonths, which
 * appends into the same payment.interestAllocations array, so walking
 * that array here undoes both the original allocation and any later
 * reconciliation), and restores the loan's principalOutstanding /
 * totalPrincipalPaid / totalInterestPaid to what they were before this
 * payment existed.
 *
 * This is the shared core of Edit (reverse, then re-apply the corrected
 * values) and Delete (reverse only) — it mutates `loan` in place but does
 * not save it; the caller saves once it's done making further changes.
 */
async function reversePaymentEffects(payment, loan, session) {
  // eslint-disable-next-line no-restricted-syntax
  for (const alloc of payment.interestAllocations) {
    // eslint-disable-next-line no-await-in-loop
    const monthRecord = await MonthlyInterest.findById(alloc.monthlyInterest).session(session || null);
    if (!monthRecord) continue; // record may have since been manually deleted — nothing left to undo
    monthRecord.paidAmount = Math.max(monthRecord.paidAmount - alloc.amountApplied, 0);
    // pendingAmount/status/paidDate are recalculated by the model's
    // pre('save') hook from interestAmount - paidAmount.
    // eslint-disable-next-line no-await-in-loop
    await monthRecord.save({ session });
  }

  loan.principalOutstanding += payment.principalPaid;
  loan.totalPrincipalPaid = Math.max(loan.totalPrincipalPaid - payment.principalPaid, 0);
  loan.totalInterestPaid = Math.max(loan.totalInterestPaid - payment.interestPaid, 0);

  // A closed loan is only ever valid with principalOutstanding === 0 (see
  // loanController.closeLoan). Reversing a payment can push it back above
  // 0, so reopen it rather than leave the loan in a state closeLoan itself
  // would never have allowed.
  if (loan.status === 'closed' && loan.principalOutstanding > 0) {
    loan.status = 'active';
    loan.closedAt = undefined;
  }
}

/**
 * Recomputes Loan.lastPaymentDate from whichever payments actually remain
 * for this loan. Pass `excludePaymentId` for a payment that still exists
 * in the collection but is being replaced/removed by the caller (e.g. an
 * edit hasn't saved its new paymentDate yet, or a delete hasn't removed
 * the document yet) so it isn't counted twice or read stale.
 */
async function recalculateLastPaymentDate(loanId, session, excludePaymentId) {
  const filter = { loan: loanId };
  if (excludePaymentId) filter._id = { $ne: excludePaymentId };
  const latest = await Payment.findOne(filter).sort({ paymentDate: -1 }).session(session || null);
  return latest ? latest.paymentDate : undefined;
}

module.exports = { reversePaymentEffects, recalculateLastPaymentDate };
