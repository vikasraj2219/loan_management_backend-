const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const MonthlyInterest = require('../models/MonthlyInterest');
const Loan = require('../models/Loan');
const withTransaction = require('../utils/withTransaction');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');
const { principalAsOfDueDate, periodKeyOf } = require('../jobs/interestJob');
const { recalculateLoanInterestTotals } = require('../services/loanTotalsService');

/**
 * These endpoints exist for the exceptional cases the brief calls out —
 * data migration, manual corrections, historical data entry — not for
 * everyday use. Normal operation should always go through the generator
 * (POST /interest/generate) and payments (POST /payments), which keep
 * everything consistent automatically. Every write here recalculates the
 * owning loan's denormalized totals immediately (Requirement 8), so a
 * manual edit or delete can never leave stale numbers on the loan, its
 * borrower's summary, or the dashboard — they all read live from this
 * collection anyway.
 */

/**
 * @desc  List monthly interest records with filters + pagination
 * @route GET /api/v1/interest-records?loan=&borrower=&status=&page=&limit=
 */
const listRecords = catchAsync(async (req, res) => {
  const { page, limit, skip, sort } = getPaginationParams({ ...req.query, sort: req.query.sort || '-year,-month' });
  const filter = {};
  if (req.query.loan) filter.loan = req.query.loan;
  if (req.query.borrower) filter.borrower = req.query.borrower;
  if (req.query.status) filter.status = req.query.status;

  const [records, total] = await Promise.all([
    MonthlyInterest.find(filter)
      .populate({ path: 'loan', select: 'loanAmount status interestRate' })
      .populate({ path: 'borrower', select: 'name phone' })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    MonthlyInterest.countDocuments(filter),
  ]);

  return new ApiResponse(200, 'Monthly interest records fetched successfully', { records }, buildPaginationMeta({ total, page, limit })).send(
    res,
    200
  );
});

/**
 * @desc  Get a single monthly interest record
 * @route GET /api/v1/interest-records/:id
 */
const getRecordById = catchAsync(async (req, res) => {
  const record = await MonthlyInterest.findById(req.params.id)
    .populate({ path: 'loan', select: 'loanAmount status interestRate' })
    .populate({ path: 'borrower', select: 'name phone' });

  if (!record) throw ApiError.notFound('Monthly interest record not found');

  return new ApiResponse(200, 'Monthly interest record fetched successfully', { record }).send(res, 200);
});

/**
 * @desc  Manually create a monthly interest record (data migration,
 *        historical entry, exceptional cases). Duplicate-guarded the same
 *        way the generator is: one record per (loan, year, month).
 * @route POST /api/v1/interest-records
 */
const createRecord = catchAsync(async (req, res) => {
  const { loan: loanId, month, year, dueDate, interestAmount, paidAmount, principalOutstandingAtCharge, interestRateAtCharge, remarks } =
    req.body;

  const loan = await Loan.findById(loanId);
  if (!loan) throw ApiError.notFound('Loan not found');

  const duplicate = await MonthlyInterest.exists({ loan: loanId, year, month });
  if (duplicate) throw ApiError.conflict(`A monthly interest record for ${month}/${year} already exists for this loan`);

  const resolvedDueDate = new Date(dueDate);
  const resolvedPrincipal =
    principalOutstandingAtCharge != null ? principalOutstandingAtCharge : await principalAsOfDueDate(loan, resolvedDueDate);
  const resolvedRate = interestRateAtCharge != null ? interestRateAtCharge : loan.interestRate;
  const resolvedInterestAmount = interestAmount != null ? interestAmount : Math.round((resolvedPrincipal * resolvedRate) / 100);

  const record = await withTransaction(async (session) => {
    const [created] = await MonthlyInterest.create(
      [
        {
          loan: loan._id,
          borrower: loan.borrower,
          month,
          year,
          periodKey: periodKeyOf(year, month),
          interestAmount: resolvedInterestAmount,
          paidAmount: paidAmount || 0,
          dueDate: resolvedDueDate,
          principalOutstandingAtCharge: resolvedPrincipal,
          interestRateAtCharge: resolvedRate,
          remarks,
          generatedAt: new Date(),
        },
      ],
      { session }
    );
    await recalculateLoanInterestTotals(loan._id, session);
    return created;
  });

  return new ApiResponse(201, 'Monthly interest record created successfully', { record }).send(res, 201);
});

/**
 * @desc  Edit a monthly interest record. Note: editing a record that's
 *        already been paid against doesn't retroactively touch any
 *        Payment's interestAllocations audit trail — this is for
 *        correcting the record itself (amount, due date, remarks), not
 *        for reversing a payment. Recalculates the loan's totals
 *        immediately either way.
 * @route PATCH /api/v1/interest-records/:id
 */
const updateRecord = catchAsync(async (req, res) => {
  const allowedFields = [
    'month',
    'year',
    'dueDate',
    'interestAmount',
    'paidAmount',
    'principalOutstandingAtCharge',
    'interestRateAtCharge',
    'remarks',
  ];

  const record = await MonthlyInterest.findById(req.params.id);
  if (!record) throw ApiError.notFound('Monthly interest record not found');

  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  const targetMonth = updates.month ?? record.month;
  const targetYear = updates.year ?? record.year;
  if (targetMonth !== record.month || targetYear !== record.year) {
    const conflict = await MonthlyInterest.exists({
      loan: record.loan,
      month: targetMonth,
      year: targetYear,
      _id: { $ne: record._id },
    });
    if (conflict) throw ApiError.conflict(`A monthly interest record for ${targetMonth}/${targetYear} already exists for this loan`);
    updates.periodKey = periodKeyOf(targetYear, targetMonth);
  }

  Object.assign(record, updates);

  const updated = await withTransaction(async (session) => {
    await record.save({ session });
    await recalculateLoanInterestTotals(record.loan, session);
    return record;
  });

  return new ApiResponse(200, 'Monthly interest record updated successfully', { record: updated }).send(res, 200);
});

/**
 * @desc  Delete a monthly interest record. Caution: if this record had
 *        already been paid against, any Payment whose interestAllocations
 *        reference it will keep that reference pointing at a deleted
 *        document — the payment's amountApplied audit entry stays, but
 *        the linked record will no longer resolve. Prefer editing over
 *        deleting for records with paidAmount > 0 where possible.
 * @route DELETE /api/v1/interest-records/:id
 */
const deleteRecord = catchAsync(async (req, res) => {
  const record = await MonthlyInterest.findById(req.params.id);
  if (!record) throw ApiError.notFound('Monthly interest record not found');

  await withTransaction(async (session) => {
    await MonthlyInterest.deleteOne({ _id: record._id }, { session });
    await recalculateLoanInterestTotals(record.loan, session);
  });

  return new ApiResponse(200, 'Monthly interest record deleted successfully', { deletedId: record._id }).send(res, 200);
});

module.exports = { listRecords, getRecordById, createRecord, updateRecord, deleteRecord };
