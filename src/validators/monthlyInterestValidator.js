const { body, param } = require('express-validator');

const createRecordRules = [
  body('loan').isMongoId().withMessage('A valid loan id is required'),
  body('month').isInt({ min: 1, max: 12 }).withMessage('Month must be between 1 and 12'),
  body('year').isInt({ min: 2000, max: 2100 }).withMessage('Year must be a valid year'),
  body('dueDate').isISO8601().withMessage('dueDate must be a valid date'),
  body('interestAmount').optional().isFloat({ min: 0 }).withMessage('interestAmount must be 0 or greater'),
  body('paidAmount').optional().isFloat({ min: 0 }).withMessage('paidAmount must be 0 or greater'),
  body('principalOutstandingAtCharge').optional().isFloat({ min: 0 }),
  body('interestRateAtCharge').optional().isFloat({ min: 0 }),
  body('remarks').optional().isLength({ max: 500 }),
];

const updateRecordRules = [
  param('id').isMongoId().withMessage('Invalid record id'),
  body('month').optional().isInt({ min: 1, max: 12 }).withMessage('Month must be between 1 and 12'),
  body('year').optional().isInt({ min: 2000, max: 2100 }).withMessage('Year must be a valid year'),
  body('dueDate').optional().isISO8601().withMessage('dueDate must be a valid date'),
  body('interestAmount').optional().isFloat({ min: 0 }),
  body('paidAmount').optional().isFloat({ min: 0 }),
  body('principalOutstandingAtCharge').optional().isFloat({ min: 0 }),
  body('interestRateAtCharge').optional().isFloat({ min: 0 }),
  body('remarks').optional().isLength({ max: 500 }),
];

const idParamRule = [param('id').isMongoId().withMessage('Invalid record id')];

module.exports = { createRecordRules, updateRecordRules, idParamRule };
