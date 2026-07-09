const express = require('express');
const {
  createBorrower,
  getBorrowers,
  getBorrowerById,
  updateBorrower,
  deleteBorrower,
} = require('../controllers/borrowerController');
const { createBorrowerRules, updateBorrowerRules, idParamRule } = require('../validators/borrowerValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');
const { createOwnerDocumentRouter } = require('./documentRoutes');

const router = express.Router();

router.use(protect); // all borrower routes require authentication

// GET /borrowers?search=&status=&page=&limit=  |  POST /borrowers
router.route('/').get(getBorrowers).post(createBorrowerRules, validate, createBorrower);

// GET /borrowers/:id  |  PATCH /borrowers/:id  |  DELETE /borrowers/:id (admin only, soft delete)
router
  .route('/:id')
  .get(idParamRule, validate, getBorrowerById)
  .patch(updateBorrowerRules, validate, updateBorrower)
  .delete(idParamRule, validate, authorize('admin'), deleteBorrower);

// /borrowers/:id/documents - full document CRUD (upload/list/view/edit/replace/delete)
// via the dedicated Document module — see documentRoutes.js. Superseded the
// old single-field "documents" array upload that used to live here; that
// only ever supported adding files, never editing, replacing, or deleting one.
router.use('/:id/documents', createOwnerDocumentRouter('borrower'));

module.exports = router;
