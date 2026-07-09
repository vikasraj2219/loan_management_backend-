/**
 * These are suggestions surfaced to the frontend for category dropdowns —
 * `Document.category` is free text (see the model's comment), not a
 * database-level enum, so the system stays generic and reusable rather
 * than hardcoding one domain's taxonomy into the schema itself. New
 * categories can be typed freely without a migration.
 */
const BORROWER_DOCUMENT_CATEGORIES = [
  'Aadhaar Card',
  'PAN Card',
  'Driving License',
  'Voter ID',
  'Passport',
  'Passport Size Photo',
  'Address Proof',
  'Income Proof',
  'Bank Passbook',
  'Salary Slip',
  'Agreement',
  'Guarantor Documents',
  'Other Documents',
];

const LOAN_DOCUMENT_CATEGORIES = [
  'Loan Agreement',
  'Promissory Note',
  'Security Documents',
  'Property Documents',
  'Gold Documents',
  'Vehicle RC',
  'Mortgage Documents',
  'Cheque Copies',
  'Payment Receipts',
  'Signed Agreements',
  'Loan Sanction Letter',
  'Other Supporting Documents',
];

module.exports = { BORROWER_DOCUMENT_CATEGORIES, LOAN_DOCUMENT_CATEGORIES };
