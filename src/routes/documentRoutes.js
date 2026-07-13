const express = require('express');
const documentUpload = require('../middlewares/documentUpload');
const {
  uploadBorrowerDocuments,
  uploadLoanDocuments,
  listBorrowerDocuments,
  listLoanDocuments,
  getBorrowerDocumentById,
  getLoanDocumentById,
  updateBorrowerDocument,
  updateLoanDocument,
  archiveBorrowerDocument,
  archiveLoanDocument,
  unarchiveBorrowerDocument,
  unarchiveLoanDocument,
  deleteBorrowerDocument,
  deleteLoanDocument,
  getAllDocuments,
  searchDocuments,
  bulkArchive,
  bulkUnarchive,
  bulkPermanentDelete,
  downloadDocument,
  previewDocument,
  getCategories,
} = require('../controllers/documentController');
const {
  uploadRules,
  updateRules,
  listQueryRules,
  documentIdParamRule,
  bulkActionRules,
} = require('../validators/documentValidator');
const validate = require('../middlewares/validate');
const { protect } = require('../middlewares/auth');

/**
 * Owner-scoped document routes. Mounted with `{ mergeParams: true }` at
 * `/borrowers/:id/documents` and `/loans/:id/documents` respectively — the
 * `:id` param is the parent resource's own, inherited via mergeParams
 * rather than redeclared here, which is what lets one factory serve both.
 */
function createOwnerDocumentRouter(ownerField) {
  const router = express.Router({ mergeParams: true });
  router.use(protect);

  const isLoan = ownerField === 'loan';
  const uploadHandler = isLoan ? uploadLoanDocuments : uploadBorrowerDocuments;
  const listHandler = isLoan ? listLoanDocuments : listBorrowerDocuments;
  const getHandler = isLoan ? getLoanDocumentById : getBorrowerDocumentById;
  const updateHandler = isLoan ? updateLoanDocument : updateBorrowerDocument;
  const archiveHandler = isLoan ? archiveLoanDocument : archiveBorrowerDocument;
  const unarchiveHandler = isLoan ? unarchiveLoanDocument : unarchiveBorrowerDocument;
  const deleteHandler = isLoan ? deleteLoanDocument : deleteBorrowerDocument;

  // GET  /:id/documents        - list, filter, paginate
  // POST /:id/documents        - upload one or more files (field "files", up to 10)
  router
    .route('/')
    .get(listQueryRules, validate, listHandler)
    .post(documentUpload.array('files', 10), uploadRules, validate, uploadHandler);

  // GET    /:id/documents/:documentId - single document
  // PUT    /:id/documents/:documentId - edit metadata, optionally replace the file (field "file")
  // DELETE /:id/documents/:documentId - soft delete (?permanent=true for hard delete, admin only)
  router
    .route('/:documentId')
    .get(documentIdParamRule, validate, getHandler)
    .put(documentUpload.single('file'), updateRules, validate, updateHandler)
    .delete(documentIdParamRule, validate, deleteHandler);

  // PATCH /:id/documents/:documentId/archive   - hide from the default Active list, file untouched
  // PATCH /:id/documents/:documentId/unarchive - restore to Active, nothing else changes
  router.patch('/:documentId/archive', documentIdParamRule, validate, archiveHandler);
  router.patch('/:documentId/unarchive', documentIdParamRule, validate, unarchiveHandler);

  return router;
}

/**
 * Global, cross-cutting document routes — not scoped to one borrower or
 * loan. Mounted at /documents in routes/index.js.
 */
const globalRouter = express.Router();
globalRouter.use(protect);

globalRouter.get('/categories', getCategories);
globalRouter.get('/search', listQueryRules, validate, searchDocuments);
globalRouter.get('/download/:documentId', documentIdParamRule, validate, downloadDocument);
globalRouter.get('/preview/:documentId', documentIdParamRule, validate, previewDocument);

// Bulk actions operate on a list of document ids directly (not owner-scoped)
// since a selection can span multiple borrowers/loans — see bulkActionRules
// for the { documentIds: [...] } body shape. Bulk permanent delete is
// admin-only, same rule as the single-document version.
globalRouter.post('/bulk/archive', bulkActionRules, validate, bulkArchive);
globalRouter.post('/bulk/unarchive', bulkActionRules, validate, bulkUnarchive);
globalRouter.post('/bulk/delete', bulkActionRules, validate, bulkPermanentDelete);

globalRouter.get('/', listQueryRules, validate, getAllDocuments);

module.exports = { createOwnerDocumentRouter, globalRouter };
