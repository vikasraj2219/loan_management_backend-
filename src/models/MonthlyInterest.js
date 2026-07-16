const mongoose = require('mongoose');

/**
 * One permanent record per loan per calendar month of interest. Created by
 * the daily cron job (src/jobs/interestJob.js) on each loan's own
 * "anniversary day" — the day-of-month the loan was disbursed — not on a
 * single fixed date for every loan.
 *
 * These records are never merged, overwritten, or deleted. A payment
 * allocated against interest updates `paidAmount` (and the derived
 * `pendingAmount`/`status` below) on the oldest unpaid record(s) first
 * (FIFO) — see paymentController.createPayment — but the record itself,
 * and its original `interestAmount`, is permanent history.
 *
 * The unique index on (loan, periodKey) is what makes generation
 * idempotent: re-running the job for a loan that already has this month's
 * record is a no-op, so a missed cron tick or a manual re-run can never
 * double-charge a borrower.
 */
const monthlyInterestSchema = new mongoose.Schema(
  {
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      required: true,
      index: true,
    },
    borrower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Borrower',
      required: true,
      index: true,
    },
    month: {
      type: Number, // 1-12
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
    },
    // Derived "YYYY-MM" — kept as a real field (not just computed) so it
    // can carry the unique index and be queried/sorted on directly.
    periodKey: {
      type: String,
      required: true,
    },
    interestAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Incremented by FIFO payment allocation; decremented only when a
    // payment that had allocated against this record is edited or deleted
    // (see paymentAdjustmentService.reversePaymentEffects). pendingAmount
    // and status are always derived from this, never set directly.
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    pendingAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'partially_paid', 'paid'],
      default: 'pending',
      index: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    paidDate: {
      type: Date,
    },
    // Snapshot of loan state at the moment this month's interest was
    // generated, for audit/reporting even if the loan changes later.
    principalOutstandingAtCharge: {
      type: Number,
      required: true,
      min: 0,
    },
    interestRateAtCharge: {
      type: Number,
      required: true,
      min: 0,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    // Free-text context for manually created/edited records — e.g. "data
    // migration from old ledger" or "corrected after borrower dispute".
    // Not used by any generated record.
    remarks: {
      type: String,
      trim: true,
      maxlength: [500, 'Remarks cannot exceed 500 characters'],
    },
  },
  { timestamps: true }
);

monthlyInterestSchema.index({ loan: 1, periodKey: 1 }, { unique: true });
monthlyInterestSchema.index({ borrower: 1, status: 1 });
monthlyInterestSchema.index({ status: 1, dueDate: 1 });

// pendingAmount and status are always derived from interestAmount/paidAmount
// — callers only ever set paidAmount, never these two directly. This keeps
// a single source of truth and makes drift between them impossible.
monthlyInterestSchema.pre('save', function syncDerivedFields(next) {
  const pending = Math.max(this.interestAmount - this.paidAmount, 0);
  this.pendingAmount = pending;

  if (pending <= 0) {
    this.status = 'paid';
    this.paidAmount = this.interestAmount; // clamp — never allow overpayment on a single month
    this.pendingAmount = 0;
    if (!this.paidDate) this.paidDate = new Date();
  } else if (this.paidAmount > 0) {
    this.status = 'partially_paid';
    this.paidDate = undefined;
  } else {
    this.status = 'pending';
    this.paidDate = undefined;
  }

  next();
});

module.exports = mongoose.model('MonthlyInterest', monthlyInterestSchema);
