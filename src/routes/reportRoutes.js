const express = require('express');
const { getCollectionReport, exportCsv, exportExcel, exportPdf } = require('../controllers/reportController');
const { protect } = require('../middlewares/auth');

const router = express.Router();

router.use(protect);

router.get('/collections', getCollectionReport);
router.get('/export/csv', exportCsv);
router.get('/export/excel', exportExcel);
router.get('/export/pdf', exportPdf);

module.exports = router;
