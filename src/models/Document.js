const mongoose = require('mongoose');

/**
 * A single uploaded file plus its metadata. A document belongs to a
 * Borrower, a Loan, or both — see the pre('validate') check below — never
 * to neither. Borrower documents (KYC, income proof, etc.) are visible
 * across every loan that borrower has; Loan documents (agreement,
 * security papers, receipts) belong to one loan only.
 *
 * The physical file lives on disk (see src/utils/fileStorage.js), but
 * every path in this schema is resolved through that one small module —
 * not scattered path.join calls — so swapping to S3/Cloudinary later only
 * means changing fileStorage.js, not this model or its controller.
 */
const documentSchema = new mongoose.Schema(
  {
    borrower: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Borrower',
      index: true,
    },
    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      index: true,
    },
    documentName: {
      type: String,
      required: [true, 'Document name is required'],
      trim: true,
      maxlength: [150, 'Document name cannot exceed 150 characters'],
    },
    // Free-text rather than a rigid enum: borrower and loan documents draw
    // from two different suggested category lists (see
    // src/constants/documentCategories.js), and the business rule calls
    // for this module to stay generic/reusable rather than hardcoding one
    // domain's taxonomy into the schema itself.
    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
      maxlength: [60, 'Category cannot exceed 60 characters'],
      index: true,
    },
    originalFileName: {
      type: String,
      required: true,
    },
    storedFileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    extension: {
      type: String,
      required: true,
      lowercase: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 0,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    tags: [{ type: String, trim: true, maxlength: 40 }],
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
      index: true,
    },
    downloadCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

documentSchema.index({ borrower: 1, status: 1 });
documentSchema.index({ loan: 1, status: 1 });
documentSchema.index({ documentName: 'text', description: 'text', tags: 'text' });

// A document must belong to a borrower, a loan, or both — never neither.
documentSchema.pre('validate', function requireOwner(next) {
  if (!this.borrower && !this.loan) {
    next(new Error('A document must be linked to a borrower and/or a loan'));
  } else {
    next();
  }
});

module.exports = mongoose.model('Document', documentSchema);
