const { body, param } = require('express-validator');

const createPaymentRules = [
  body('loan').isMongoId().withMessage('A valid loan id is required'),
  body('paymentDate').optional().isISO8601().withMessage('Payment date must be a valid date'),
  body('principalPaid').optional().isFloat({ min: 0 }).withMessage('Principal paid must be 0 or greater'),
  body('interestPaid').optional().isFloat({ min: 0 }).withMessage('Interest paid must be 0 or greater'),
  body('paymentMode').optional().isIn(['cash', 'bank_transfer', 'upi', 'cheque', 'other']),
  body('referenceNumber').optional().isLength({ max: 100 }),
  body('remarks').optional().isLength({ max: 500 }),
  body().custom((value) => {
    const principal = Number(value.principalPaid) || 0;
    const interest = Number(value.interestPaid) || 0;
    if (principal <= 0 && interest <= 0) {
      throw new Error('At least one of principalPaid or interestPaid must be greater than 0');
    }
    return true;
  }),
];

const updatePaymentRules = [
  param('id').isMongoId().withMessage('Invalid payment id'),
  body('paymentDate').optional().isISO8601().withMessage('Payment date must be a valid date'),
  body('principalPaid').optional().isFloat({ min: 0 }).withMessage('Principal paid must be 0 or greater'),
  body('interestPaid').optional().isFloat({ min: 0 }).withMessage('Interest paid must be 0 or greater'),
  body('paymentMode').optional().isIn(['cash', 'bank_transfer', 'upi', 'cheque', 'other']),
  body('referenceNumber').optional().isLength({ max: 100 }),
  body('remarks').optional().isLength({ max: 500 }),
];

const idParamRule = [param('id').isMongoId().withMessage('Invalid payment id')];

module.exports = { createPaymentRules, updatePaymentRules, idParamRule };
