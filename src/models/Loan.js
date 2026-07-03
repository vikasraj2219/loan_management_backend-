const mongoose = require('mongoose');

/**
 * NOTE: This is a Phase-1 placeholder so that Borrower virtual populate
 * and referential checks work end-to-end. Full loan/interest business
 * logic (principal tracking, interest generation, closure rules, etc.)
 * is implemented in Phase 2 — this schema will be extended there,
 * not replaced, so existing data remains compatible.
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
    status: {
      type: String,
      enum: ['active', 'closed', 'overdue'],
      default: 'active',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

loanSchema.index({ borrower: 1, status: 1 });

module.exports = mongoose.model('Loan', loanSchema);
