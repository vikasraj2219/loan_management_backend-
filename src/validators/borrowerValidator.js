const { body, param } = require('express-validator');

const createBorrowerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 150 }),
  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9+\-\s()]{7,15}$/)
    .withMessage('Please provide a valid phone number'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Please provide a valid email'),
  body('address').optional().isLength({ max: 500 }),
  body('idProofType')
    .optional()
    .isIn(['aadhaar', 'pan', 'passport', 'voter_id', 'driving_license', 'other']),
  body('status').optional().isIn(['active', 'inactive']),
];

const updateBorrowerRules = [
  param('id').isMongoId().withMessage('Invalid borrower id'),
  body('name').optional().trim().isLength({ max: 150 }),
  body('phone')
    .optional()
    .trim()
    .matches(/^[0-9+\-\s()]{7,15}$/)
    .withMessage('Please provide a valid phone number'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Please provide a valid email'),
  body('status').optional().isIn(['active', 'inactive']),
];

const idParamRule = [param('id').isMongoId().withMessage('Invalid borrower id')];

module.exports = { createBorrowerRules, updateBorrowerRules, idParamRule };
