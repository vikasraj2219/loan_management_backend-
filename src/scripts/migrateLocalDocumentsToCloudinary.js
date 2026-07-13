/* eslint-disable no-console, no-await-in-loop */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Document = require('../models/Document');
const Payment = require('../models/Payment');
const { getAbsolutePath } = require('../utils/fileStorage');
const cloudinaryService = require('../services/cloudinaryService');

/**
 * One-time backfill: uploads every document AND payment receipt still on
 * local disk to Cloudinary and updates its record with the new metadata,
 * per the "Existing Data Migration" section of the brief (Cloudinary
 * integration is reusable across modules, receipts included). Safe to
 * re-run — it only ever selects records that still lack a
 * `cloudinaryPublicId`, so anything already migrated is skipped.
 *
 * Usage:
 *   npm run migrate:cloudinary            # migrate, keep local files as a safety net
 *   npm run migrate:cloudinary -- --delete-local   # also delete the local file after a successful upload
 */
const deleteLocalAfterMigration = process.argv.includes('--delete-local');

const migrateDocuments = async () => {
  // Legacy documents are identified by having a filePath but no
  // cloudinaryPublicId — NOT by storageProvider, since Mongoose applies
  // that field's schema default ('cloudinary') to any hydrated document
  // that predates the field existing at all, which would be wrong here.
  const legacyDocuments = await Document.find({
    cloudinaryPublicId: { $exists: false },
    filePath: { $exists: true, $ne: null },
  });

  console.log(`Found ${legacyDocuments.length} document(s) still on local storage.`);

  const summary = { migrated: 0, missingFile: 0, failed: 0 };

  for (const doc of legacyDocuments) {
    const absolutePath = getAbsolutePath(doc.filePath);

    if (!fs.existsSync(absolutePath)) {
      console.warn(`  [skip] ${doc._id} — local file missing: ${absolutePath}`);
      summary.missingFile += 1;
      continue;
    }

    try {
      const buffer = fs.readFileSync(absolutePath);
      const ownerField = doc.loan ? 'loan' : 'borrower';

      const result = await cloudinaryService.uploadBuffer(buffer, {
        category: doc.category,
        ownerField,
        mimeType: doc.mimeType,
      });

      doc.storageProvider = 'cloudinary';
      doc.cloudinaryPublicId = result.public_id;
      doc.secureUrl = result.secure_url;
      doc.resourceType = result.resource_type;
      doc.folder = result.folder;
      await doc.save();

      if (deleteLocalAfterMigration) {
        fs.unlinkSync(absolutePath);
      }

      console.log(`  [ok]   document ${doc._id} — ${doc.originalFileName} -> ${result.public_id}`);
      summary.migrated += 1;
    } catch (err) {
      console.error(`  [fail] document ${doc._id} — ${err.message}`);
      summary.failed += 1;
    }
  }

  return summary;
};

const migrateReceipts = async () => {
  const legacyPayments = await Payment.find({
    'receiptFile.filePath': { $exists: true, $ne: null },
    'receiptFile.cloudinaryPublicId': { $exists: false },
  });

  console.log(`Found ${legacyPayments.length} payment receipt(s) still on local storage.`);

  const summary = { migrated: 0, missingFile: 0, failed: 0 };

  for (const payment of legacyPayments) {
    const absolutePath = getAbsolutePath(payment.receiptFile.filePath);

    if (!fs.existsSync(absolutePath)) {
      console.warn(`  [skip] payment ${payment._id} — local file missing: ${absolutePath}`);
      summary.missingFile += 1;
      continue;
    }

    try {
      const buffer = fs.readFileSync(absolutePath);
      const ext = (payment.receiptFile.filePath.split('.').pop() || '').toLowerCase();
      const mimeType = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[ext] || 'application/pdf';

      const result = await cloudinaryService.uploadBuffer(buffer, { category: 'Payment Receipt', mimeType });

      payment.receiptFile.storageProvider = 'cloudinary';
      payment.receiptFile.cloudinaryPublicId = result.public_id;
      payment.receiptFile.secureUrl = result.secure_url;
      payment.receiptFile.resourceType = result.resource_type;
      await payment.save();

      if (deleteLocalAfterMigration) {
        fs.unlinkSync(absolutePath);
      }

      console.log(`  [ok]   receipt on payment ${payment._id} -> ${result.public_id}`);
      summary.migrated += 1;
    } catch (err) {
      console.error(`  [fail] receipt on payment ${payment._id} — ${err.message}`);
      summary.failed += 1;
    }
  }

  return summary;
};

const run = async () => {
  await connectDB();

  const documentSummary = await migrateDocuments();
  const receiptSummary = await migrateReceipts();

  console.log('\nDocument migration summary:', documentSummary);
  console.log('Receipt migration summary:', receiptSummary);

  const totalMigrated = documentSummary.migrated + receiptSummary.migrated;
  const totalFailed = documentSummary.failed + receiptSummary.failed;

  if (!deleteLocalAfterMigration && totalMigrated > 0) {
    console.log('\nLocal files were kept as a safety net. Re-run with --delete-local once you\'ve verified the migration.');
  }

  await mongoose.connection.close();
  process.exit(totalFailed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error('Migration failed to run:', err);
  process.exit(1);
});
