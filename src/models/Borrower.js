const mongoose = require('mongoose');

const borrowerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Borrower name is required'],
      trim: true,
      maxlength: [150, 'Name cannot exceed 150 characters'],
      index: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      match: [/^[0-9+\-\s()]{7,15}$/, 'Please provide a valid phone number'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
      sparse: true,
    },
    address: {
      type: String,
      trim: true,
      maxlength: [500, 'Address cannot exceed 500 characters'],
    },
    idProofType: {
      type: String,
      enum: ['aadhaar', 'pan', 'passport', 'voter_id', 'driving_license', 'other'],
      default: 'other',
    },
    idProofNumber: {
      type: String,
      trim: true,
    },
    occupation: {
      type: String,
      trim: true,
    },
    guarantorName: {
      type: String,
      trim: true,
    },
    guarantorPhone: {
      type: String,
      trim: true,
    },
    documents: [
      {
        fileName: String,
        filePath: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    notes: {
      type: String,
      maxlength: [1000, 'Notes cannot exceed 1000 characters'],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
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

// Text index to support search across name/phone/email
borrowerSchema.index({ name: 'text', phone: 'text', email: 'text' });

// Virtual populate: loans belonging to this borrower
borrowerSchema.virtual('loans', {
  ref: 'Loan',
  localField: '_id',
  foreignField: 'borrower',
});

borrowerSchema.set('toJSON', { virtuals: true });
borrowerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Borrower', borrowerSchema);
