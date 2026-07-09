const fs = require('fs');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Document = require('../models/Document');
const Borrower = require('../models/Borrower');
const Loan = require('../models/Loan');
const { buildFileMetadata, getAbsolutePath, deleteFile } = require('../utils/fileStorage');
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

/** Shared by owner-scoped and global listing — category/status/type/date/search filters. */
function applyCommonFilters(filter, query) {
  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status; // omit entirely to show active + archived
  if (query.fileType) filter.extension = String(query.fileType).toLowerCase().replace(/^\./, '');
  if (query.search) filter.$text = { $search: query.search };
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
  }
}

/**
 * @desc  Upload one or more documents for a borrower or a loan.
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

    const tags = parseTags(req.body.tags);
    const created = [];
    let duplicateWarning = false;

    for (const file of req.files) {
      const meta = buildFileMetadata(file);

      // Optional duplicate guard — same owner, same name+size, still active.
      // Doesn't block the upload, just flags it for the UI to warn about.
      // eslint-disable-next-line no-await-in-loop
      const existingDuplicate = await Document.exists({
        [ownerField]: ownerId,
        originalFileName: meta.originalFileName,
        fileSize: meta.fileSize,
        status: 'active',
      });
      if (existingDuplicate) duplicateWarning = true;

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
        metadata: { ownerField, ownerId, fileName: meta.originalFileName },
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
 *        `updatedAt` change; the old physical file is deleted.
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
      const oldFilePath = document.filePath;
      Object.assign(document, buildFileMetadata(req.file));
      deleteFile(oldFilePath);
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
 * @desc  Delete a document. Soft delete (default) archives it — the
 *        record and file both remain. Permanent delete (?permanent=true,
 *        admin only) removes the file from disk and the DB record.
 *        Never touches borrower/loan/payment/interest records either way.
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
      deleteFile(document.filePath);
      await Document.deleteOne({ _id: document._id });
    } else {
      document.status = 'archived';
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
 * @desc  Download a document's original file, preserving its filename.
 * @route GET /api/v1/documents/download/:documentId
 */
const downloadDocument = catchAsync(async (req, res) => {
  const document = await Document.findById(req.params.documentId);
  if (!document) throw ApiError.notFound('Document not found');

  const absolutePath = getAbsolutePath(document.filePath);
  if (!fs.existsSync(absolutePath)) throw ApiError.notFound('File is missing from storage');

  document.downloadCount += 1;
  await document.save();

  await logActivity({
    action: 'document.download',
    entityType: 'Document',
    entityId: document._id,
    performedBy: req.user._id,
  });

  res.download(absolutePath, document.originalFileName);
});

/**
 * @desc  Stream a document inline for in-browser preview (PDF viewer /
 *        image tag) rather than triggering a download.
 * @route GET /api/v1/documents/preview/:documentId
 */
const previewDocument = catchAsync(async (req, res) => {
  const document = await Document.findById(req.params.documentId);
  if (!document) throw ApiError.notFound('Document not found');

  const absolutePath = getAbsolutePath(document.filePath);
  if (!fs.existsSync(absolutePath)) throw ApiError.notFound('File is missing from storage');

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.originalFileName)}"`);
  fs.createReadStream(absolutePath).pipe(res);
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
  deleteBorrowerDocument: deleteDocument('borrower'),
  deleteLoanDocument: deleteDocument('loan'),
  getAllDocuments,
  searchDocuments: getAllDocuments,
  downloadDocument,
  previewDocument,
  getCategories,
};
