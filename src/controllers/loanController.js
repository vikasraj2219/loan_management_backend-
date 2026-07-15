const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Loan = require('../models/Loan');
const Borrower = require('../models/Borrower');
const MonthlyInterest = require('../models/MonthlyInterest');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');

/**
 * @desc  Create a new loan for a borrower
 * @route POST /api/v1/loans
 */
const createLoan = catchAsync(async (req, res) => {
  const borrower = await Borrower.findById(req.body.borrower);
  if (!borrower) throw ApiError.notFound('Borrower not found');
  if (borrower.status !== 'active') {
    throw ApiError.badRequest('Cannot create a loan for an inactive borrower');
  }

  const loan = await Loan.create({ ...req.body, createdBy: req.user._id });

  // No interest is generated here on purpose: the first interest cycle
  // only completes one full month after loanDate (Requirement 1), so the
  // first MonthlyInterest record is created by the daily cron — or a
  // manual "Generate Missing Interest Records" run — once that first
  // due date actually arrives. Charging interest on the disbursal day
  // itself would be wrong regardless of when it happened.
  await loan.populate({ path: 'borrower', select: 'name phone status' });

  return new ApiResponse(201, 'Loan created successfully', { loan }).send(res, 201);
});

/**
 * @desc  List loans with filters, search, and pagination
 * @route GET /api/v1/loans
 * Query params: page, limit, sort, status, borrower, minAmount, maxAmount, minRate, maxRate
 */
const getLoans = catchAsync(async (req, res) => {
  const { page, limit, skip, sort } = getPaginationParams(req.query);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.borrower) filter.borrower = req.query.borrower;

  if (req.query.minAmount || req.query.maxAmount) {
    filter.loanAmount = {};
    if (req.query.minAmount) filter.loanAmount.$gte = Number(req.query.minAmount);
    if (req.query.maxAmount) filter.loanAmount.$lte = Number(req.query.maxAmount);
  }

  if (req.query.minRate || req.query.maxRate) {
    filter.interestRate = {};
    if (req.query.minRate) filter.interestRate.$gte = Number(req.query.minRate);
    if (req.query.maxRate) filter.interestRate.$lte = Number(req.query.maxRate);
  }

  const [rawLoans, total] = await Promise.all([
    Loan.find(filter)
      .populate({ path: 'borrower', select: 'name phone status' })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Loan.countDocuments(filter),
  ]);

  // `.lean({ virtuals: true })` silently does nothing without the
  // mongoose-lean-virtuals plugin (not installed here) — plain Mongoose
  // `.lean()` always strips virtuals regardless of that option. That left
  // currentMonthlyInterest/pendingInterest/totalOutstanding undefined on
  // every loan in this list, which the frontend was rendering as ₹0.
  // Recompute them here with the exact same formulas as the schema's
  // virtuals (see loanSchema.virtual(...) in models/Loan.js) so the list
  // matches what GET /loans/:id already returns.
  const loans = rawLoans.map((loan) => {
    const pendingInterest = Math.max((loan.totalInterestAccrued || 0) - (loan.totalInterestPaid || 0), 0);
    return {
      ...loan,
      currentMonthlyInterest: Math.round((loan.principalOutstanding * loan.interestRate) / 100),
      pendingInterest,
      totalOutstanding: loan.principalOutstanding + pendingInterest,
    };
  });

  return new ApiResponse(200, 'Loans fetched successfully', { loans }, buildPaginationMeta({ total, page, limit })).send(res, 200);
});

/**
 * @desc  Get a single loan by id
 * @route GET /api/v1/loans/:id
 */
const getLoanById = catchAsync(async (req, res) => {
  const loan = await Loan.findById(req.params.id)
    .populate({ path: 'borrower', select: 'name phone email status' })
    .populate({ path: 'payments', options: { sort: { paymentDate: -1 } } });

  if (!loan) throw ApiError.notFound('Loan not found');

  return new ApiResponse(200, 'Loan fetched successfully', { loan }).send(res, 200);
});

/**
 * @desc  Update loan metadata (interest rate, tenure, due date, notes).
 *        Principal cannot be edited directly — only through payments.
 * @route PATCH /api/v1/loans/:id
 */
const updateLoan = catchAsync(async (req, res) => {
  const allowedFields = ['interestRate', 'tenureMonths', 'dueDate', 'notes'];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  const loan = await Loan.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true }).populate({
    path: 'borrower',
    select: 'name phone status',
  });

  if (!loan) throw ApiError.notFound('Loan not found');

  return new ApiResponse(200, 'Loan updated successfully', { loan }).send(res, 200);
});

/**
 * @desc  Close a loan once its principal is fully repaid.
 *        Loans are never deleted — closing preserves full history.
 * @route PATCH /api/v1/loans/:id/close
 */
const closeLoan = catchAsync(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw ApiError.notFound('Loan not found');

  if (loan.status === 'closed') {
    throw ApiError.badRequest('Loan is already closed');
  }

  if (loan.principalOutstanding > 0) {
    throw ApiError.badRequest(
      `Cannot close loan with outstanding principal of ${loan.principalOutstanding}. Record remaining payments first.`
    );
  }

  loan.status = 'closed';
  loan.closedAt = new Date();
  await loan.save();

  return new ApiResponse(200, 'Loan closed successfully', { loan }).send(res, 200);
});

/**
 * @desc  Mark a loan as overdue (manual flag; automatic overdue detection
 *        based on due dates arrives with the Phase 4 scheduler).
 * @route PATCH /api/v1/loans/:id/mark-overdue
 */
const markOverdue = catchAsync(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  if (!loan) throw ApiError.notFound('Loan not found');
  if (loan.status === 'closed') throw ApiError.badRequest('Cannot mark a closed loan as overdue');

  loan.status = 'overdue';
  await loan.save();

  return new ApiResponse(200, 'Loan marked as overdue', { loan }).send(res, 200);
});

/**
 * @desc  Full month-by-month interest schedule for a loan, plus a summary
 *        (pending months, pending amount, oldest/latest unpaid month,
 *        last paid date, next due date). Computed dynamically from the
 *        MonthlyInterest collection every time — never from a cached total.
 * @route GET /api/v1/loans/:id/interest
 */
const getLoanInterestSchedule = catchAsync(async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate({ path: 'borrower', select: 'name phone' });
  if (!loan) throw ApiError.notFound('Loan not found');

  const months = await MonthlyInterest.find({ loan: loan._id }).sort({ year: 1, month: 1 }).lean();

  const pending = months.filter((m) => m.status !== 'paid');
  const paidMonths = months.filter((m) => m.status === 'paid');

  const summary = {
    pendingMonths: pending.length,
    pendingInterestAmount: pending.reduce((sum, m) => sum + m.pendingAmount, 0),
    oldestPendingMonth: pending[0] || null,
    latestPendingMonth: pending.length ? pending[pending.length - 1] : null,
    lastInterestPaidOn: paidMonths.length ? paidMonths[paidMonths.length - 1].paidDate : null,
    nextInterestDueDate: pending.length ? pending[0].dueDate : null,
  };

  return new ApiResponse(200, 'Loan interest schedule fetched successfully', { loan, months, summary }).send(res, 200);
});

module.exports = {
  createLoan,
  getLoans,
  getLoanById,
  updateLoan,
  closeLoan,
  markOverdue,
  getLoanInterestSchedule,
};
