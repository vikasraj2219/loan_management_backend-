const mongoose = require('mongoose');

/**
 * Interest model used by this system: simple monthly interest calculated
 * on the current outstanding principal (common for private/informal
 * lending). Each month, interest due = principalOutstanding * (interestRate / 100).
 * Interest does NOT compound into principal — it is tracked and collected
 * separately (see Payment model, Phase 3).
 */
const loanSchema = new mongoose.Schema(
  {
    borrower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Borrower',
      required: true,
      index: true,
    },
    loanAmount: {
      type: Number,
      required: [true, 'Loan amount is required'],
      min: [1, 'Loan amount must be greater than 0'],
    },
    // Current remaining principal. Starts equal to loanAmount and is only
    // ever reduced by recorded principal payments (Phase 3) — never edited
    // directly, so the audit trail always reconciles.
    principalOutstanding: {
      type: Number,
      required: true,
      min: 0,
    },
    interestRate: {
      type: Number,
      required: [true, 'Monthly interest rate is required'],
      min: 0,
    },
    interestType: {
      type: String,
      enum: ['flat_monthly'], // reserved for future types (reducing, yearly, etc.)
      default: 'flat_monthly',
    },
    loanDate: {
      type: Date,
      required: [true, 'Loan date is required'],
      default: Date.now,
    },
    tenureMonths: {
      type: Number,
      min: 1,
    },
    dueDate: {
      type: Date,
    },
    // Denormalized running totals, updated by the Payment module (Phase 3).
    // Kept on the loan itself so list views never need to aggregate payments.
    totalPrincipalPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalInterestPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Running total of every InterestCharge ever generated for this loan
    // by the monthly cron job (Phase 4). pendingInterest = this minus
    // totalInterestPaid — see the virtual below.
    totalInterestAccrued: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastInterestGeneratedAt: {
      type: Date,
    },
    lastPaymentDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['active', 'closed', 'overdue'],
      default: 'active',
      index: true,
    },
    closedAt: {
      type: Date,
    },
    notes: {
      type: String,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

loanSchema.index({ borrower: 1, status: 1 });
loanSchema.index({ status: 1, dueDate: 1 });

// Loan starts fully outstanding.
loanSchema.pre('validate', function setInitialOutstanding(next) {
  if (this.isNew && (this.principalOutstanding === undefined || this.principalOutstanding === null)) {
    this.principalOutstanding = this.loanAmount;
  }
  next();
});

// Current month's interest due, computed on demand (not stored, so it's
// always accurate even if interestRate or principalOutstanding changes).
loanSchema.virtual('currentMonthlyInterest').get(function getCurrentMonthlyInterest() {
  return Math.round((this.principalOutstanding * this.interestRate) / 100);
});

loanSchema.virtual('pendingInterest').get(function getPendingInterest() {
  return Math.max(this.totalInterestAccrued - this.totalInterestPaid, 0);
});

loanSchema.virtual('totalOutstanding').get(function getTotalOutstanding() {
  return this.principalOutstanding + Math.max(this.totalInterestAccrued - this.totalInterestPaid, 0);
});

// Payments belonging to this loan (Phase 3).
loanSchema.virtual('payments', {
  ref: 'Payment',
  localField: '_id',
  foreignField: 'loan',
});

loanSchema.set('toJSON', { virtuals: true });
loanSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Loan', loanSchema);
