const { body } = require('express-validator');

const generateInterestRules = [
  body('loanId').optional().isMongoId().withMessage('loanId must be a valid id'),
  body('borrowerId').optional().isMongoId().withMessage('borrowerId must be a valid id'),
  body('generateTill').optional().isISO8601().withMessage('generateTill must be a valid date'),
];

module.exports = { generateInterestRules };
