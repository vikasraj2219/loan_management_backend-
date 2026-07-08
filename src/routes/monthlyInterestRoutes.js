const express = require('express');
const { listRecords, getRecordById, createRecord, updateRecord, deleteRecord } = require('../controllers/monthlyInterestController');
const { createRecordRules, updateRecordRules, idParamRule } = require('../validators/monthlyInterestValidator');
const validate = require('../middlewares/validate');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();

// Manual CRUD on the interest ledger is an admin-only correction tool —
// staff should record payments and run the generator instead.
router.use(protect, authorize('admin'));

router.route('/').get(listRecords).post(createRecordRules, validate, createRecord);

router
  .route('/:id')
  .get(idParamRule, validate, getRecordById)
  .patch(updateRecordRules, validate, updateRecord)
  .delete(idParamRule, validate, deleteRecord);

module.exports = router;
