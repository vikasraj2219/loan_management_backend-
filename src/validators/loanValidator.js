const { body, param } = require('express-validator');

const createLoanRules = [
  body('borrower').isMongoId().withMessage('A valid borrower id is required'),
  body('loanAmount').isFloat({ gt: 0 }).withMessage('Loan amount must be greater than 0'),
  body('interestRate').isFloat({ min: 0 }).withMessage('Interest rate must be 0 or greater'),
  body('loanDate').optional().isISO8601().withMessage('Loan date must be a valid date'),
  body('tenureMonths').optional().isInt({ min: 1 }).withMessage('Tenure must be at least 1 month'),
  body('dueDate').optional().isISO8601().withMessage('Due date must be a valid date'),
  body('notes').optional().isLength({ max: 1000 }),
];

const updateLoanRules = [
  param('id').isMongoId().withMessage('Invalid loan id'),
  body('interestRate').optional().isFloat({ min: 0 }).withMessage('Interest rate must be 0 or greater'),
  body('tenureMonths').optional().isInt({ min: 1 }).withMessage('Tenure must be at least 1 month'),
  body('dueDate').optional().isISO8601().withMessage('Due date must be a valid date'),
  body('notes').optional().isLength({ max: 1000 }),
  // loanAmount and principalOutstanding are intentionally not editable here —
  // principal only changes through recorded payments (Phase 3).
];

const idParamRule = [param('id').isMongoId().withMessage('Invalid loan id')];

module.exports = { createLoanRules, updateLoanRules, idParamRule };
