const mongoose = require('mongoose');

/**
 * A permanent record of interest generated for a loan in a given calendar
 * month. Created by the monthly cron job (see src/jobs/interestJob.js).
 * The unique index on (loan, periodKey) makes generation idempotent —
 * re-running the job (manually, or after a missed cron tick) can never
 * double-charge the same loan for the same month.
 *
 * `Loan.totalInterestAccrued` is a running total of these amounts, kept in
 * sync at creation time so dashboard/report queries don't need to re-sum
 * this collection on every request.
 */
const interestChargeSchema = new mongoose.Schema(
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
    // e.g. "2026-07" — the calendar month this charge applies to
    periodKey: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
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
  },
  { timestamps: true }
);

interestChargeSchema.index({ loan: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model('InterestCharge', interestChargeSchema);
