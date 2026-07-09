const { body, param, query } = require('express-validator');

const ownerIdParamRule = (paramName) => param(paramName).isMongoId().withMessage(`Invalid ${paramName}`);

const documentIdParamRule = param('documentId').isMongoId().withMessage('Invalid document id');

// Upload requests arrive as multipart/form-data — non-file fields land in
// req.body as strings, so validation here is intentionally lenient about
// type coercion (tags may be a JSON array string or comma-separated list;
// the controller normalizes it).
const uploadRules = [
  body('category').notEmpty().withMessage('Category is required').isLength({ max: 60 }),
  body('documentName').optional().isLength({ max: 150 }),
  body('description').optional().isLength({ max: 1000 }),
];

const updateRules = [
  documentIdParamRule,
  body('documentName').optional().isLength({ max: 150 }),
  body('category').optional().isLength({ max: 60 }),
  body('description').optional().isLength({ max: 1000 }),
  body('status').optional().isIn(['active', 'archived']).withMessage('Status must be active or archived'),
];

const listQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['active', 'archived']),
  query('fileType').optional().isLength({ max: 20 }),
  query('dateFrom').optional().isISO8601(),
  query('dateTo').optional().isISO8601(),
];

module.exports = { ownerIdParamRule, documentIdParamRule, uploadRules, updateRules, listQueryRules };
