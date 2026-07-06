const express = require('express');
const { generateInterestRecords } = require('../controllers/interestController');
const { generateInterestRules } = require('../validators/interestValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();

router.use(protect, authorize('admin'));

// POST /interest/generate - backfill every missing monthly interest record
// for a specific loan, a specific borrower's loans, or every active loan.
// Body: { loanId?, borrowerId?, generateTill? }
router.post('/generate', generateInterestRules, validate, generateInterestRecords);

module.exports = router;
