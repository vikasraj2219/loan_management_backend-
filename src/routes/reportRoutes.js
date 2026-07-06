const express = require('express');
const {
  getCollectionReport,
  exportCsv,
  exportExcel,
  exportPdf,
  getPendingInterestReport,
  getOverdueInterestReport,
  getInterestCollectionHistory,
  exportPendingInterestCsv,
} = require('../controllers/reportController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.use(protect);

router.get('/collections', getCollectionReport);
router.get('/export/csv', exportCsv);
router.get('/export/excel', exportExcel);
router.get('/export/pdf', exportPdf);

// Pending Monthly Interest Tracking reports
router.get('/pending-interest', getPendingInterestReport);
router.get('/overdue-interest', getOverdueInterestReport);
router.get('/interest-collection-history', getInterestCollectionHistory);
router.get('/export/pending-interest/csv', exportPendingInterestCsv);

module.exports = router;
