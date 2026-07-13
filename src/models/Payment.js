const mongoose = require('mongoose');

/**
 * A Payment is a permanent, immutable ledger entry. Once recorded, its
 * financial fields (principalPaid, interestPaid) are never edited or
 * deleted — this is what lets Loan.principalOutstanding, totalPrincipalPaid
 * and totalInterestPaid be trusted as a running total instead of a
 * recalculated guess. Only non-financial metadata (remarks, reference
 * number, payment mode, receipt) can be corrected after the fact.
 */
const paymentSchema = new mongoose.Schema(
  {
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      required: true,
      index: true,
    },
    // Denormalized so payment history can be queried per-borrower without
    // an extra join through Loan — useful for the Payments module's
    // borrower filter and for future dashboard aggregations.
    borrower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Borrower',
      required: true,
      index: true,
    },
    paymentDate: {
      type: Date,
      required: [true, 'Payment date is required'],
      default: Date.now,
    },
    principalPaid: {
      type: Number,
      default: 0,
      min: [0, 'Principal paid cannot be negative'],
    },
    interestPaid: {
      type: Number,
      default: 0,
      min: [0, 'Interest paid cannot be negative'],
    },
    paymentMode: {
      type: String,
      enum: ['cash', 'bank_transfer', 'upi', 'cheque', 'other'],
      default: 'cash',
    },
    referenceNumber: {
      type: String,
      trim: true,
    },
    remarks: {
      type: String,
      trim: true,
      maxlength: [500, 'Remarks cannot exceed 500 characters'],
    },
    // Uploaded to Cloudinary via the same fileStorage.js/cloudinaryService.js
    // used by the Document module (see business rule: the Cloudinary
    // integration is reusable across modules, not document-specific).
    // fileName/filePath are kept for any receipt uploaded before this
    // migration; new uploads populate the cloudinary* fields instead.
    receiptFile: {
      fileName: String,
      filePath: String,
      storageProvider: { type: String, enum: ['cloudinary', 'local'] },
      cloudinaryPublicId: String,
      secureUrl: String,
      resourceType: String,
    },
    // Audit trail of exactly which month(s) this payment's interestPaid was
    // applied to, in FIFO order (oldest unpaid month first — see
    // paymentController.createPayment). A single payment can span several
    // months if it clears more than one. Empty when interestPaid is 0, or
    // when interestPaid exceeds all currently-pending months (the leftover
    // is recorded but not tied to a specific month — see
    // `unallocatedInterest` below).
    interestAllocations: [
      {
        monthlyInterest: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyInterest' },
        month: Number,
        year: Number,
        amountApplied: Number,
      },
    ],
    // Any portion of interestPaid that didn't fit into a pending month
    // (e.g. borrower pays ahead of what's been generated so far). Kept
    // visible rather than silently dropped.
    unallocatedInterest: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Snapshot of the loan's outstanding principal immediately after this
    // payment was applied. Stored at write-time (not computed later) so
    // the historical ledger reads correctly even if the loan changes further.
    principalOutstandingAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ loan: 1, paymentDate: -1 });
paymentSchema.index({ borrower: 1, paymentDate: -1 });

// A payment must move at least one of principal or interest.
paymentSchema.pre('validate', function requireAmount(next) {
  if ((this.principalPaid || 0) <= 0 && (this.interestPaid || 0) <= 0) {
    next(new Error('At least one of principalPaid or interestPaid must be greater than 0'));
  } else {
    next();
  }
});

module.exports = mongoose.model('Payment', paymentSchema);
