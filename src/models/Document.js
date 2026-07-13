const mongoose = require('mongoose');

/**
 * A single uploaded file plus its metadata. A document belongs to a
 * Borrower, a Loan, or both — see the pre('validate') check below — never
 * to neither. Borrower documents (KYC, income proof, etc.) are visible
 * across every loan that borrower has; Loan documents (agreement,
 * security papers, receipts) belong to one loan only.
 *
 * Storage: every new file lives in Cloudinary (see src/utils/fileStorage.js
 * and src/services/cloudinaryService.js) — nothing new is written to local
 * disk. Documents uploaded before this migration keep their legacy
 * `filePath`/`fileUrl` and `storageProvider: 'local'`, and continue to work
 * via fileStorage.js's local-fallback branch until `npm run
 * migrate:cloudinary` moves them over. Every path/URL in this schema is
 * still resolved through that one module, not scattered calls — so a
 * future move to S3 or Azure Blob would again mean changing one file, not
 * this model or its controller.
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
    // Legacy local-storage fields — optional now. Populated for documents
    // uploaded before the Cloudinary migration; new uploads leave these
    // unset (storageProvider is 'cloudinary' instead). Kept, not removed,
    // so pre-migration documents keep working via fileStorage.js's
    // local-fallback branch until `npm run migrate:cloudinary` runs.
    filePath: {
      type: String,
    },
    fileUrl: {
      type: String,
    },
    // Cloudinary fields — populated for every new upload.
    storageProvider: {
      type: String,
      enum: ['cloudinary', 'local'],
      default: 'cloudinary',
    },
    cloudinaryPublicId: {
      type: String,
    },
    secureUrl: {
      type: String,
    },
    resourceType: {
      type: String,
      enum: ['image', 'raw', 'video'],
    },
    folder: {
      type: String,
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
    // Archive lifecycle audit trail — who archived/restored a document and
    // when, distinct from the generic ActivityLog so the document's own
    // record is self-explanatory without a join.
    archivedAt: {
      type: Date,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    unarchivedAt: {
      type: Date,
    },
    unarchivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
