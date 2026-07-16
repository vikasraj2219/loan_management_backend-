const express = require('express');
const {
  createPayment,
  getPayments,
  getPaymentById,
  updatePayment,
  deletePayment,
  uploadReceipt,
} = require('../controllers/paymentController');
const { createPaymentRules, updatePaymentRules, idParamRule } = require('../validators/paymentValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');
const upload = require('../middlewares/upload');

const router = express.Router();

router.use(protect); // all payment routes require authentication

// GET /payments?loan=&borrower=&paymentMode=&dateFrom=&dateTo=&page=&limit=  |  POST /payments
router.route('/').get(getPayments).post(createPaymentRules, validate, createPayment);

// GET /payments/:id  |  PATCH /payments/:id (edit, admin only)  |  DELETE /payments/:id (admin only)
router
  .route('/:id')
  .get(idParamRule, validate, getPaymentById)
  .patch(authorize('admin'), updatePaymentRules, validate, updatePayment)
  .delete(authorize('admin'), idParamRule, validate, deletePayment);

// POST /payments/:id/receipt - upload a receipt/proof file
router.post('/:id/receipt', idParamRule, validate, upload.single('receipt'), uploadReceipt);

module.exports = router;
