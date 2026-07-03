const express = require('express');
const {
  createBorrower,
  getBorrowers,
  getBorrowerById,
  updateBorrower,
  deleteBorrower,
  uploadDocuments,
} = require('../controllers/borrowerController');
const { createBorrowerRules, updateBorrowerRules, idParamRule } = require('../validators/borrowerValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');
const upload = require('../middlewares/upload');

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

// POST /borrowers/:id/documents - upload KYC documents (multipart, field "documents", max 5 files)
router.post('/:id/documents', idParamRule, validate, upload.array('documents', 5), uploadDocuments);

module.exports = router;
