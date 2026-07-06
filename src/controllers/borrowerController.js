const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Borrower = require('../models/Borrower');
const MonthlyInterest = require('../models/MonthlyInterest');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');

/**
 * @desc  Create a new borrower
 * @route POST /api/v1/borrowers
 */
const createBorrower = catchAsync(async (req, res) => {
  const payload = { ...req.body, createdBy: req.user._id };
  const borrower = await Borrower.create(payload);
  return new ApiResponse(201, 'Borrower created successfully', { borrower }).send(res, 201);
});

/**
 * @desc  List borrowers with search, filter, and pagination
 * @route GET /api/v1/borrowers
 * Query params: page, limit, sort, search, status
 */
const getBorrowers = catchAsync(async (req, res) => {
  const { page, limit, skip, sort } = getPaginationParams(req.query);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;

  if (req.query.search) {
    const regex = new RegExp(req.query.search.trim(), 'i');
    filter.$or = [{ name: regex }, { phone: regex }, { email: regex }];
  }

  const [borrowers, total] = await Promise.all([
    Borrower.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Borrower.countDocuments(filter),
  ]);

  return new ApiResponse(200, 'Borrowers fetched successfully', { borrowers }, buildPaginationMeta({ total, page, limit })).send(
    res,
    200
  );
});

/**
 * @desc  Get a single borrower by id (with loans populated)
 * @route GET /api/v1/borrowers/:id
 */
const getBorrowerById = catchAsync(async (req, res) => {
  const borrower = await Borrower.findById(req.params.id).populate({
    path: 'loans',
    select: 'loanAmount principalOutstanding interestRate status createdAt',
  });

  if (!borrower) throw ApiError.notFound('Borrower not found');

  // Interest summary across every loan this borrower has, computed fresh
  // from the MonthlyInterest ledger — never from a cached total.
  const pendingMonths = await MonthlyInterest.find({ borrower: borrower._id, status: { $ne: 'paid' } })
    .sort({ year: 1, month: 1 })
    .lean();
  const lastPaid = await MonthlyInterest.findOne({ borrower: borrower._id, status: 'paid' })
    .sort({ paidDate: -1 })
    .lean();

  const interestSummary = {
    pendingMonths: pendingMonths.length,
    pendingInterestAmount: pendingMonths.reduce((sum, m) => sum + m.pendingAmount, 0),
    oldestPendingMonth: pendingMonths[0] || null,
    latestPendingMonth: pendingMonths.length ? pendingMonths[pendingMonths.length - 1] : null,
    lastInterestPaidOn: lastPaid?.paidDate || null,
    nextInterestDueDate: pendingMonths.length ? pendingMonths[0].dueDate : null,
  };

  return new ApiResponse(200, 'Borrower fetched successfully', { borrower, interestSummary }).send(res, 200);
});

/**
 * @desc  Update a borrower
 * @route PATCH /api/v1/borrowers/:id
 */
const updateBorrower = catchAsync(async (req, res) => {
  const borrower = await Borrower.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!borrower) throw ApiError.notFound('Borrower not found');

  return new ApiResponse(200, 'Borrower updated successfully', { borrower }).send(res, 200);
});

/**
 * @desc  Soft-delete (deactivate) a borrower. Borrowers are never hard-deleted
 *        because historical loan/payment records must remain intact.
 * @route DELETE /api/v1/borrowers/:id
 */
const deleteBorrower = catchAsync(async (req, res) => {
  const Loan = require('../models/Loan');
  const activeLoans = await Loan.exists({ borrower: req.params.id, status: 'active' });
  if (activeLoans) {
    throw ApiError.badRequest('Cannot delete a borrower with active loans. Close all loans first.');
  }

  const borrower = await Borrower.findByIdAndUpdate(req.params.id, { status: 'inactive' }, { new: true });
  if (!borrower) throw ApiError.notFound('Borrower not found');

  return new ApiResponse(200, 'Borrower deactivated successfully', { borrower }).send(res, 200);
});

/**
 * @desc  Upload KYC documents for a borrower
 * @route POST /api/v1/borrowers/:id/documents
 */
const uploadDocuments = catchAsync(async (req, res) => {
  const borrower = await Borrower.findById(req.params.id);
  if (!borrower) throw ApiError.notFound('Borrower not found');

  if (!req.files || req.files.length === 0) {
    throw ApiError.badRequest('At least one document file is required');
  }

  const documents = req.files.map((file) => ({
    fileName: file.originalname,
    filePath: file.path.replace(/\\/g, '/'),
  }));

  borrower.documents.push(...documents);
  await borrower.save();

  return new ApiResponse(200, 'Documents uploaded successfully', { borrower }).send(res, 200);
});

module.exports = {
  createBorrower,
  getBorrowers,
  getBorrowerById,
  updateBorrower,
  deleteBorrower,
  uploadDocuments,
};
