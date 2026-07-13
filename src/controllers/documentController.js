const fs = require('fs');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Document = require('../models/Document');
const Borrower = require('../models/Borrower');
const Loan = require('../models/Loan');
const { uploadFile, getAbsolutePath, deleteFile, buildDeliveryUrl } = require('../utils/fileStorage');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');
const { logActivity } = require('../services/activityLogService');
const { BORROWER_DOCUMENT_CATEGORIES, LOAN_DOCUMENT_CATEGORIES } = require('../constants/documentCategories');

const OWNER_MODELS = { borrower: Borrower, loan: Loan };
const OWNER_LABEL = { borrower: 'Borrower', loan: 'Loan' };

/** Accepts a JSON array string, a comma-separated string, or an actual array. */
const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
  } catch (err) {
    // not JSON — fall through to comma-split
  }
  return String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
};

/** Confirms the owner referenced by the URL exists — same 404 everywhere. */
async function requireOwner(ownerField, ownerId) {
  const owner = await OWNER_MODELS[ownerField].findById(ownerId);
  if (!owner) throw ApiError.notFound(`${OWNER_LABEL[ownerField]} not found`);
  return owner;
}

/**
 * Shared by owner-scoped and global listing — category/status/type/date/
 * search filters. Status defaults to `active` (archived documents are
 * excluded from every default view, per the brief); `status=all` shows
 * both; `status=archived` shows only archived.
 */
function applyCommonFilters(filter, query) {
  if (query.category) filter.category = query.category;
  if (query.status === 'all') {
    // no status filter — Active + Archived both included
  } else {
    filter.status = query.status || 'active';
  }
  if (query.fileType) filter.extension = String(query.fileType).toLowerCase().replace(/^\./, '');
  if (query.search) filter.$text = { $search: query.search };
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
  }
}

/**
 * @desc  Upload one or more documents for a borrower or a loan. Every
 *        file is streamed straight to Cloudinary (see fileStorage.js) —
 *        nothing is written to local disk.
 * @route POST /api/v1/borrowers/:id/documents
 * @route POST /api/v1/loans/:id/documents
 */
const uploadDocuments = (ownerField) =>
  catchAsync(async (req, res) => {
    const ownerId = req.params.id;
    const owner = await requireOwner(ownerField, ownerId);

    if (!req.files || req.files.length === 0) {
      throw ApiError.badRequest('At least one file is required');
    }
    if (!req.body.category) {
      throw ApiError.badRequest('Category is required');
    }

    const emptyFile = req.files.find((f) => f.size === 0);
    if (emptyFile) {
      throw ApiError.badRequest(`"${emptyFile.originalname}" is empty (0 bytes) and cannot be uploaded`);
    }

    const tags = parseTags(req.body.tags);
    const created = [];
    let duplicateWarning = false;

    for (const file of req.files) {
      // Optional duplicate guard — same owner, same name+size, still active.
      // Doesn't block the upload, just flags it for the UI to warn about.
      // eslint-disable-next-line no-await-in-loop
      const existingDuplicate = await Document.exists({
        [ownerField]: ownerId,
        originalFileName: file.originalname,
        fileSize: file.size,
        status: 'active',
      });
      if (existingDuplicate) duplicateWarning = true;

      let meta;
      try {
        // eslint-disable-next-line no-await-in-loop
        meta = await uploadFile(file, { category: req.body.category, ownerField });
      } catch (err) {
        throw ApiError.internal(`Failed to upload "${file.originalname}" to Cloudinary: ${err.message}`);
      }

      const payload = {
        [ownerField]: ownerId,
        documentName: req.body.documentName || meta.originalFileName,
        category: req.body.category,
        description: req.body.description,
        tags,
        uploadedBy: req.user._id,
        ...meta,
      };
      // A loan document is also stamped with its borrower, so a borrower's
      // Documents tab gives a holistic view (their KYC *and* every loan's
      // paperwork) while a loan's own view stays strictly scoped to it.
      if (ownerField === 'loan') payload.borrower = owner.borrower;

      // eslint-disable-next-line no-await-in-loop
      const doc = await Document.create(payload);
      created.push(doc);

      // eslint-disable-next-line no-await-in-loop
      await logActivity({
        action: 'document.upload',
        entityType: 'Document',
        entityId: doc._id,
        performedBy: req.user._id,
        metadata: { ownerField, ownerId, fileName: meta.originalFileName, storageProvider: 'cloudinary' },
      });
    }

    return new ApiResponse(201, 'Document(s) uploaded successfully', { documents: created, duplicateWarning }).send(res, 201);
  });

/**
 * @desc  List documents for a borrower or a loan, filtered + paginated.
 * @route GET /api/v1/borrowers/:id/documents
 * @route GET /api/v1/loans/:id/documents
 */
const listOwnerDocuments = (ownerField) =>
  catchAsync(async (req, res) => {
    const ownerId = req.params.id;
    await requireOwner(ownerField, ownerId);

    const { page, limit, skip, sort } = getPaginationParams({ ...req.query, sort: req.query.sort || '-createdAt' });
    const filter = { [ownerField]: ownerId };
    applyCommonFilters(filter, req.query);

    const [documents, total] = await Promise.all([
      Document.find(filter).populate({ path: 'uploadedBy', select: 'name' }).sort(sort).skip(skip).limit(limit).lean(),
      Document.countDocuments(filter),
    ]);

    return new ApiResponse(200, 'Documents fetched successfully', { documents }, buildPaginationMeta({ total, page, limit })).send(
      res,
      200
    );
  });

/**
 * @desc  Get a single document, scoped to its owner (prevents guessing a
 *        documentId to view something outside the URL's borrower/loan).
 * @route GET /api/v1/borrowers/:id/documents/:documentId
 * @route GET /api/v1/loans/:id/documents/:documentId
 */
const getOwnerDocumentById = (ownerField) =>
  catchAsync(async (req, res) => {
    const document = await Document.findOne({ _id: req.params.documentId, [ownerField]: req.params.id }).populate({
      path: 'uploadedBy',
      select: 'name',
    });
    if (!document) throw ApiError.notFound('Document not found');

    return new ApiResponse(200, 'Document fetched successfully', { document }).send(res, 200);
  });

/**
 * @desc  Edit a document's metadata, and optionally replace its file.
 *        Replacing keeps the same document _id — only the file fields and
 *        `updatedAt` change. The new file uploads to Cloudinary first;
 *        only once that succeeds is the old Cloudinary asset (or legacy
 *        local file) deleted, so a failed upload never leaves the
 *        document pointing at nothing.
 * @route PUT /api/v1/borrowers/:id/documents/:documentId
 * @route PUT /api/v1/loans/:id/documents/:documentId
 */
const updateDocument = (ownerField) =>
  catchAsync(async (req, res) => {
    const document = await Document.findOne({ _id: req.params.documentId, [ownerField]: req.params.id });
    if (!document) throw ApiError.notFound('Document not found');

    ['documentName', 'category', 'description', 'status'].forEach((field) => {
      if (req.body[field] !== undefined) document[field] = req.body[field];
    });
    if (req.body.tags !== undefined) document.tags = parseTags(req.body.tags);

    let replaced = false;
    if (req.file) {
      if (req.file.size === 0) throw ApiError.badRequest(`"${req.file.originalname}" is empty (0 bytes) and cannot be uploaded`);

      // Snapshot the OLD file's storage info before overwriting the
      // document's fields with the new upload's metadata.
      const oldFileSnapshot = {
        storageProvider: document.storageProvider,
        cloudinaryPublicId: document.cloudinaryPublicId,
        resourceType: document.resourceType,
        filePath: document.filePath,
      };

      let meta;
      try {
        meta = await uploadFile(req.file, { category: document.category, ownerField });
      } catch (err) {
        throw ApiError.internal(`Failed to upload "${req.file.originalname}" to Cloudinary: ${err.message}`);
      }

      // Clear legacy local fields explicitly in case this replaces a
      // pre-migration document — it becomes a Cloudinary document from
      // here on, not a half-local/half-cloud record.
      document.filePath = undefined;
      document.fileUrl = undefined;
      Object.assign(document, meta);

      await deleteFile(oldFileSnapshot);
      replaced = true;
    }

    await document.save();

    await logActivity({
      action: replaced ? 'document.replace' : 'document.edit',
      entityType: 'Document',
      entityId: document._id,
      performedBy: req.user._id,
      metadata: { ownerField, ownerId: req.params.id },
    });

    return new ApiResponse(200, 'Document updated successfully', { document }).send(res, 200);
  });

/**
 * @desc  Archive a document — hides it from the default (Active) list
 *        without touching the file in Cloudinary or any metadata.
 *        Reversible via unarchive.
 * @route PATCH /api/v1/borrowers/:id/documents/:documentId/archive
 * @route PATCH /api/v1/loans/:id/documents/:documentId/archive
 */
const archiveDocument = (ownerField) =>
  catchAsync(async (req, res) => {
    const document = await Document.findOne({ _id: req.params.documentId, [ownerField]: req.params.id });
    if (!document) throw ApiError.notFound('Document not found');

    document.status = 'archived';
    document.archivedAt = new Date();
    document.archivedBy = req.user._id;
    await document.save();

    await logActivity({
      action: 'document.archive',
      entityType: 'Document',
      entityId: document._id,
      performedBy: req.user._id,
      metadata: { ownerField, ownerId: req.params.id },
    });

    return new ApiResponse(200, 'Document archived successfully', { document }).send(res, 200);
  });

/**
 * @desc  Restore an archived document to Active. Upload date, file, and
 *        every other field are untouched.
 * @route PATCH /api/v1/borrowers/:id/documents/:documentId/unarchive
 * @route PATCH /api/v1/loans/:id/documents/:documentId/unarchive
 */
const unarchiveDocument = (ownerField) =>
  catchAsync(async (req, res) => {
    const document = await Document.findOne({ _id: req.params.documentId, [ownerField]: req.params.id });
    if (!document) throw ApiError.notFound('Document not found');

    document.status = 'active';
    document.unarchivedAt = new Date();
    document.unarchivedBy = req.user._id;
    await document.save();

    await logActivity({
      action: 'document.unarchive',
      entityType: 'Document',
      entityId: document._id,
      performedBy: req.user._id,
      metadata: { ownerField, ownerId: req.params.id },
    });

    return new ApiResponse(200, 'Document restored successfully', { document }).send(res, 200);
  });

/**
 * @desc  Delete a document. Soft delete (default) archives it — same as
 *        the dedicated archive endpoint, kept here for backward
 *        compatibility with the existing single-delete flow. Permanent
 *        delete (?permanent=true, admin only) removes the Cloudinary
 *        asset (or legacy local file) AND the DB record — there is never
 *        an orphaned file left behind either way. Never touches
 *        borrower/loan/payment/interest records.
 * @route DELETE /api/v1/borrowers/:id/documents/:documentId
 * @route DELETE /api/v1/loans/:id/documents/:documentId
 */
const deleteDocument = (ownerField) =>
  catchAsync(async (req, res) => {
    const document = await Document.findOne({ _id: req.params.documentId, [ownerField]: req.params.id });
    if (!document) throw ApiError.notFound('Document not found');

    const permanent = req.query.permanent === 'true';
    if (permanent && req.user.role !== 'admin') {
      throw ApiError.forbidden('Only an admin can permanently delete a document');
    }

    if (permanent) {
      await deleteFile(document);
      await Document.deleteOne({ _id: document._id });
    } else {
      document.status = 'archived';
      document.archivedAt = new Date();
      document.archivedBy = req.user._id;
      await document.save();
    }

    await logActivity({
      action: permanent ? 'document.delete.permanent' : 'document.delete.soft',
      entityType: 'Document',
      entityId: document._id,
      performedBy: req.user._id,
      metadata: { ownerField, ownerId: req.params.id },
    });

    return new ApiResponse(200, permanent ? 'Document permanently deleted' : 'Document archived successfully', {
      deletedId: document._id,
      permanent,
    }).send(res, 200);
  });

/**
 * @desc  List/search documents across every borrower and loan.
 * @route GET /api/v1/documents
 * @route GET /api/v1/documents/search   (identical — an explicit alias)
 */
const getAllDocuments = catchAsync(async (req, res) => {
  const { page, limit, skip, sort } = getPaginationParams({ ...req.query, sort: req.query.sort || '-createdAt' });
  const filter = {};
  if (req.query.borrower) filter.borrower = req.query.borrower;
  if (req.query.loan) filter.loan = req.query.loan;
  applyCommonFilters(filter, req.query);

  const [documents, total] = await Promise.all([
    Document.find(filter)
      .populate({ path: 'borrower', select: 'name phone' })
      .populate({ path: 'loan', select: 'loanAmount status' })
      .populate({ path: 'uploadedBy', select: 'name' })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Document.countDocuments(filter),
  ]);

  return new ApiResponse(200, 'Documents fetched successfully', { documents }, buildPaginationMeta({ total, page, limit })).send(
    res,
    200
  );
});

/**
 * @desc  Bulk archive, unarchive, or permanently delete documents by id.
 *        Bulk permanent delete is admin-only, same as the single-document
 *        version; archive/unarchive are available to any authenticated
 *        user. Each item is processed independently so one bad id doesn't
 *        abort the whole batch — the response reports exactly what
 *        succeeded and what didn't.
 * @route POST /api/v1/documents/bulk/archive
 * @route POST /api/v1/documents/bulk/unarchive
 * @route POST /api/v1/documents/bulk/delete
 */
const bulkAction = (action) =>
  catchAsync(async (req, res) => {
    const { documentIds } = req.body;

    if (action === 'delete' && req.user.role !== 'admin') {
      throw ApiError.forbidden('Only an admin can permanently delete documents');
    }

    const results = { succeeded: [], failed: [] };

    for (const documentId of documentIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const document = await Document.findById(documentId);
        if (!document) {
          results.failed.push({ documentId, reason: 'Document not found' });
          // eslint-disable-next-line no-continue
          continue;
        }

        if (action === 'archive') {
          document.status = 'archived';
          document.archivedAt = new Date();
          document.archivedBy = req.user._id;
          // eslint-disable-next-line no-await-in-loop
          await document.save();
        } else if (action === 'unarchive') {
          document.status = 'active';
          document.unarchivedAt = new Date();
          document.unarchivedBy = req.user._id;
          // eslint-disable-next-line no-await-in-loop
          await document.save();
        } else if (action === 'delete') {
          // eslint-disable-next-line no-await-in-loop
          await deleteFile(document);
          // eslint-disable-next-line no-await-in-loop
          await Document.deleteOne({ _id: document._id });
        }

        // eslint-disable-next-line no-await-in-loop
        await logActivity({
          action: `document.bulk.${action}`,
          entityType: 'Document',
          entityId: documentId,
          performedBy: req.user._id,
        });

        results.succeeded.push(documentId);
      } catch (err) {
        results.failed.push({ documentId, reason: err.message });
      }
    }

    const messages = { archive: 'archived', unarchive: 'restored', delete: 'permanently deleted' };
    return new ApiResponse(
      200,
      `${results.succeeded.length} of ${documentIds.length} document(s) ${messages[action]} successfully`,
      results
    ).send(res, 200);
  });

/**
 * @desc  Download a document's original file, preserving its filename.
 *        Cloudinary documents redirect to a signed, attachment-flagged
 *        Cloudinary URL (no file passes through our server); legacy local
 *        documents stream directly from disk.
 * @route GET /api/v1/documents/download/:documentId
 */
const downloadDocument = catchAsync(async (req, res) => {
  const document = await Document.findById(req.params.documentId);
  if (!document) throw ApiError.notFound('Document not found');

  document.downloadCount += 1;
  await document.save();

  await logActivity({
    action: 'document.download',
    entityType: 'Document',
    entityId: document._id,
    performedBy: req.user._id,
  });

  const cloudinaryUrl = buildDeliveryUrl(document, { attachment: true });
  if (cloudinaryUrl) {
    return res.redirect(cloudinaryUrl);
  }

  // Legacy local document — stream from disk.
  const absolutePath = getAbsolutePath(document.filePath);
  if (!fs.existsSync(absolutePath)) throw ApiError.notFound('File is missing from storage');
  return res.download(absolutePath, document.originalFileName);
});

/**
 * @desc  Redirect to (Cloudinary) or stream (legacy local) a document
 *        inline for in-browser preview (PDF viewer / image tag) rather
 *        than triggering a download.
 * @route GET /api/v1/documents/preview/:documentId
 */
const previewDocument = catchAsync(async (req, res) => {
  const document = await Document.findById(req.params.documentId);
  if (!document) throw ApiError.notFound('Document not found');

  const cloudinaryUrl = buildDeliveryUrl(document, { attachment: false });
  if (cloudinaryUrl) {
    return res.redirect(cloudinaryUrl);
  }

  // Legacy local document — stream from disk.
  const absolutePath = getAbsolutePath(document.filePath);
  if (!fs.existsSync(absolutePath)) throw ApiError.notFound('File is missing from storage');
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.originalFileName)}"`);
  return fs.createReadStream(absolutePath).pipe(res);
});

/**
 * @desc  Suggested category list for a document upload form's dropdown.
 * @route GET /api/v1/documents/categories?type=borrower|loan
 */
const getCategories = catchAsync(async (req, res) => {
  const type = req.query.type === 'loan' ? 'loan' : 'borrower';
  const categories = type === 'loan' ? LOAN_DOCUMENT_CATEGORIES : BORROWER_DOCUMENT_CATEGORIES;
  return new ApiResponse(200, 'Categories fetched successfully', { categories }).send(res, 200);
});

module.exports = {
  uploadBorrowerDocuments: uploadDocuments('borrower'),
  uploadLoanDocuments: uploadDocuments('loan'),
  listBorrowerDocuments: listOwnerDocuments('borrower'),
  listLoanDocuments: listOwnerDocuments('loan'),
  getBorrowerDocumentById: getOwnerDocumentById('borrower'),
  getLoanDocumentById: getOwnerDocumentById('loan'),
  updateBorrowerDocument: updateDocument('borrower'),
  updateLoanDocument: updateDocument('loan'),
  archiveBorrowerDocument: archiveDocument('borrower'),
  archiveLoanDocument: archiveDocument('loan'),
  unarchiveBorrowerDocument: unarchiveDocument('borrower'),
  unarchiveLoanDocument: unarchiveDocument('loan'),
  deleteBorrowerDocument: deleteDocument('borrower'),
  deleteLoanDocument: deleteDocument('loan'),
  getAllDocuments,
  searchDocuments: getAllDocuments,
  bulkArchive: bulkAction('archive'),
  bulkUnarchive: bulkAction('unarchive'),
  bulkPermanentDelete: bulkAction('delete'),
  downloadDocument,
  previewDocument,
  getCategories,
};
