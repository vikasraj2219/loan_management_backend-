const express = require('express');
const {
  getSummary,
  getCollectionTrend,
  getPrincipalInterestTrend,
  getLoanStatusDistribution,
  getRecentPayments,
  getOverdueLoans,
  getTopBorrowers,
} = require('../controllers/dashboardController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.use(protect);

router.get('/summary', getSummary);
router.get('/collection-trend', getCollectionTrend);
router.get('/principal-interest-trend', getPrincipalInterestTrend);
router.get('/loan-status-distribution', getLoanStatusDistribution);
router.get('/recent-payments', getRecentPayments);
router.get('/overdue-loans', getOverdueLoans);
router.get('/top-borrowers', getTopBorrowers);

module.exports = router;
