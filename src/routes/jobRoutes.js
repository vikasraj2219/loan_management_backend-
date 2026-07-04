const express = require('express');
const { runInterestGeneration, runOverdueCheck } = require('../controllers/jobController');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();

router.use(protect, authorize('admin'));

// POST /jobs/generate-interest - manually run the monthly interest job (idempotent)
router.post('/generate-interest', runInterestGeneration);

// POST /jobs/check-overdue - manually run the overdue-loan check
router.post('/check-overdue', runOverdueCheck);

module.exports = router;
