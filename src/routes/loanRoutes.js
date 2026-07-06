const express = require('express');
const {
  createLoan,
  getLoans,
  getLoanById,
  updateLoan,
  closeLoan,
  markOverdue,
  getLoanInterestSchedule,
} = require('../controllers/loanController');
const { createLoanRules, updateLoanRules, idParamRule } = require('../validators/loanValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();

router.use(protect); // all loan routes require authentication

// GET /loans?status=&borrower=&minAmount=&maxAmount=&minRate=&maxRate=&page=&limit=  |  POST /loans
router.route('/').get(getLoans).post(createLoanRules, validate, createLoan);

// GET /loans/:id  |  PATCH /loans/:id (metadata only — principal changes via payments, Phase 3)
router
  .route('/:id')
  .get(idParamRule, validate, getLoanById)
  .patch(updateLoanRules, validate, updateLoan);

// GET /loans/:id/interest - full month-by-month interest schedule + pending summary
router.get('/:id/interest', idParamRule, validate, getLoanInterestSchedule);

// PATCH /loans/:id/close - close a fully repaid loan
router.patch('/:id/close', idParamRule, validate, closeLoan);

// PATCH /loans/:id/mark-overdue - flag a loan as overdue (admin only)
router.patch('/:id/mark-overdue', idParamRule, validate, authorize('admin'), markOverdue);

module.exports = router;
