const express = require('express');
const authRoutes = require('./authRoutes');
const borrowerRoutes = require('./borrowerRoutes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'API is healthy', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/borrowers', borrowerRoutes);

// Phase 2 will add: router.use('/loans', loanRoutes);
// Phase 3 will add: router.use('/payments', paymentRoutes);
// Phase 4 will add: router.use('/dashboard', dashboardRoutes); router.use('/reports', reportRoutes);

module.exports = router;
