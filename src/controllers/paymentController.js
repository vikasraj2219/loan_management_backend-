const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');
const { allocateInterestFifo } = require('../services/interestAllocationService');
const withTransaction = require('../utils/withTransaction');
const { uploadFile } = require('../utils/fileStorage');

/**
 * @desc  Record a payment (principal and/or interest) against a loan.
 *        This is the only way a loan's principalOutstanding ever changes,
 *        and the only way any MonthlyInterest record's paidAmount changes
 *        — interest is always applied oldest-month-first (FIFO), never to
 *        a month the caller picks.
 * @route POST /api/v1/payments
 *
 * Wrapped in a transaction (via withTransaction) so the Payment insert,
 * the FIFO interest allocation across however many MonthlyInterest
 * records it touches, and the Loan balance update all commit atomically
 * — with a graceful fallback to sequential writes on a standalone
 * (non-replica-set) MongoDB, which doesn't support transactions at all.
 */
const createPayment = catchAsync(async (req, res) => {
  const { loan: loanId, paymentDate, paymentMode, referenceNumber, remarks } = req.body;
  const principalPaid = Number(req.body.principalPaid) || 0;
  const interestPaid = Number(req.body.interestPaid) || 0;
  const effectiveDate = paymentDate || Date.now();

  const loan = await Loan.findById(loanId);
  if (!loan) throw ApiError.notFound('Loan not found');

  if (loan.status === 'closed') {
    throw ApiError.badRequest('Cannot record a payment against a closed loan');
  }

  if (principalPaid > loan.principalOutstanding) {
    throw ApiError.badRequest(
      `Principal paid (${principalPaid}) cannot exceed the outstanding principal (${loan.principalOutstanding})`
    );
  }

  const newOutstanding = loan.principalOutstanding - principalPaid;

  const payment = await withTransaction(async (session) => {
    const allocationResult = await allocateInterestFifo(loan._id, interestPaid, effectiveDate, session);

    const [created] = await Payment.create(
      [
        {
          loan: loan._id,
          borrower: loan.borrower,
          paymentDate: effectiveDate,
          principalPaid,
          interestPaid,
          paymentMode,
          referenceNumber,
          remarks,
          principalOutstandingAfter: newOutstanding,
          interestAllocations: allocationResult.allocations,
          unallocatedInterest: allocationResult.unallocated,
          recordedBy: req.user._id,
        },
      ],
      { session: session || undefined }
    );

    loan.principalOutstanding = newOutstanding;
    loan.totalPrincipalPaid += principalPaid;
    loan.totalInterestPaid += interestPaid;
    loan.lastPaymentDate = created.paymentDate;
    await loan.save({ session: session || undefined });

    return created;
  });

  await payment.populate([
    { path: 'loan', select: 'loanAmount principalOutstanding interestRate status' },
    { path: 'borrower', select: 'name phone' },
  ]);

  return new ApiResponse(201, 'Payment recorded successfully', { payment, loan }).send(res, 201);
});

/**
 * @desc  List payments with filters and pagination
 * @route GET /api/v1/payments
 * Query params: loan, borrower, paymentMode, dateFrom, dateTo, page, limit, sort
 */
const getPayments = catchAsync(async (req, res) => {
  const { page, limit, skip, sort } = getPaginationParams({ ...req.query, sort: req.query.sort || '-paymentDate' });
  const filter = {};

  if (req.query.loan) filter.loan = req.query.loan;
  if (req.query.borrower) filter.borrower = req.query.borrower;
  if (req.query.paymentMode) filter.paymentMode = req.query.paymentMode;

  if (req.query.dateFrom || req.query.dateTo) {
    filter.paymentDate = {};
    if (req.query.dateFrom) filter.paymentDate.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo) filter.paymentDate.$lte = new Date(req.query.dateTo);
  }

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .populate({ path: 'borrower', select: 'name phone' })
      .populate({ path: 'loan', select: 'loanAmount status' })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Payment.countDocuments(filter),
  ]);

  return new ApiResponse(200, 'Payments fetched successfully', { payments }, buildPaginationMeta({ total, page, limit })).send(
    res,
    200
  );
});

/**
 * @desc  Get a single payment
 * @route GET /api/v1/payments/:id
 */
const getPaymentById = catchAsync(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .populate({ path: 'loan', select: 'loanAmount principalOutstanding interestRate status' })
    .populate({ path: 'borrower', select: 'name phone email' })
    .populate({ path: 'recordedBy', select: 'name email' });

  if (!payment) throw ApiError.notFound('Payment not found');

  return new ApiResponse(200, 'Payment fetched successfully', { payment }).send(res, 200);
});

/**
 * @desc  Update non-financial metadata only (mode, reference, remarks).
 *        principalPaid / interestPaid — and which months they cleared —
 *        are permanent once recorded.
 * @route PATCH /api/v1/payments/:id
 */
const updatePayment = catchAsync(async (req, res) => {
  const allowedFields = ['paymentMode', 'referenceNumber', 'remarks'];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  const payment = await Payment.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
  if (!payment) throw ApiError.notFound('Payment not found');

  return new ApiResponse(200, 'Payment updated successfully', { payment }).send(res, 200);
});

/**
 * @desc  Upload a receipt/proof image or PDF for a payment
 * @route POST /api/v1/payments/:id/receipt
 */
const uploadReceipt = catchAsync(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw ApiError.notFound('Payment not found');

  if (!req.file) throw ApiError.badRequest('A receipt file is required');
  if (req.file.size === 0) throw ApiError.badRequest('The uploaded file is empty (0 bytes)');

  let meta;
  try {
    meta = await uploadFile(req.file, { category: 'Payment Receipt' });
  } catch (err) {
    throw ApiError.internal(`Failed to upload receipt to Cloudinary: ${err.message}`);
  }

  payment.receiptFile = {
    fileName: meta.originalFileName,
    storageProvider: 'cloudinary',
    cloudinaryPublicId: meta.cloudinaryPublicId,
    secureUrl: meta.secureUrl,
    resourceType: meta.resourceType,
  };
  await payment.save();

  return new ApiResponse(200, 'Receipt uploaded successfully', { payment }).send(res, 200);
});

module.exports = { createPayment, getPayments, getPaymentById, updatePayment, uploadReceipt };
