const express = require('express');
const authRoutes = require('./authRoutes');
const borrowerRoutes = require('./borrowerRoutes');
const loanRoutes = require('./loanRoutes');
const paymentRoutes = require('./paymentRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const reportRoutes = require('./reportRoutes');
const jobRoutes = require('./jobRoutes');
const interestRoutes = require('./interestRoutes');
const monthlyInterestRoutes = require('./monthlyInterestRoutes');
const { globalRouter: documentGlobalRoutes } = require('./documentRoutes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'API is healthy', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/borrowers', borrowerRoutes);
router.use('/loans', loanRoutes);
router.use('/payments', paymentRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/reports', reportRoutes);
router.use('/jobs', jobRoutes);
router.use('/interest', interestRoutes);
router.use('/interest-records', monthlyInterestRoutes);
router.use('/documents', documentGlobalRoutes);

module.exports = router;
