const express = require('express');
const authRoutes = require('./authRoutes');
const borrowerRoutes = require('./borrowerRoutes');
const loanRoutes = require('./loanRoutes');
const paymentRoutes = require('./paymentRoutes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'API is healthy', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/borrowers', borrowerRoutes);
router.use('/loans', loanRoutes);
router.use('/payments', paymentRoutes);

// Phase 4 will add: router.use('/dashboard', dashboardRoutes); router.use('/reports', reportRoutes);

module.exports = router;
