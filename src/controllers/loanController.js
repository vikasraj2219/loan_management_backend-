const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Loan = require('../models/Loan');
const Borrower = require('../models/Borrower');
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

  const [loans, total] = await Promise.all([
    Loan.find(filter)
      .populate({ path: 'borrower', select: 'name phone status' })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    Loan.countDocuments(filter),
  ]);

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

module.exports = { createLoan, getLoans, getLoanById, updateLoan, closeLoan, markOverdue };
