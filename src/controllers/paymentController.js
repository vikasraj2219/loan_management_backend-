const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const MonthlyInterest = require('../models/MonthlyInterest');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');

/**
 * Applies `interestAmount` to a loan's pending MonthlyInterest records,
 * oldest month first (FIFO) — this is the only allocation rule in the
 * system; there is no way for a user to pick which month a payment clears.
 * Returns { allocations, unallocated } where `allocations` records exactly
 * how much went to which month (for the Payment's audit trail) and
 * `unallocated` is whatever didn't fit into any pending month.
 */
async function allocateInterestFifo(loanId, interestAmount, paidOn, session) {
  const allocations = [];
  let remaining = interestAmount;

  if (remaining <= 0) return { allocations, unallocated: 0 };

  const pendingMonths = await MonthlyInterest.find({
    loan: loanId,
    status: { $in: ['pending', 'partially_paid'] },
  })
    .sort({ year: 1, month: 1 }) // oldest first — FIFO
    .session(session || null);

  for (const monthRecord of pendingMonths) {
    if (remaining <= 0) break;

    const before = monthRecord.pendingAmount;
    if (before <= 0) continue;

    const applied = Math.min(remaining, before);
    monthRecord.paidAmount += applied;
    // pendingAmount/status/paidDate are recalculated by the model's
    // pre('save') hook from interestAmount - paidAmount — never set directly.
    // eslint-disable-next-line no-await-in-loop
    await monthRecord.save({ session });

    allocations.push({
      monthlyInterest: monthRecord._id,
      month: monthRecord.month,
      year: monthRecord.year,
      amountApplied: applied,
    });

    remaining -= applied;
  }

  return { allocations, unallocated: remaining };
}

/**
 * @desc  Record a payment (principal and/or interest) against a loan.
 *        This is the only way a loan's principalOutstanding ever changes,
 *        and the only way any MonthlyInterest record's paidAmount changes
 *        — interest is always applied oldest-month-first (FIFO), never to
 *        a month the caller picks.
 * @route POST /api/v1/payments
 *
 * NOTE ON CONSISTENCY: ideally this runs inside a MongoDB transaction so
 * the Payment insert, Loan update, and every MonthlyInterest update commit
 * atomically. Transactions require a replica-set deployment; a standalone
 * `mongod` (common in local dev) does not support them. This code
 * opportunistically uses a transaction when the connection supports it,
 * and falls back to sequential writes otherwise — documented here rather
 * than hidden, since it's the one place in this codebase where a partial
 * failure could leave data slightly inconsistent.
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

  const buildPaymentDoc = (allocationResult) => ({
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
  });

  const session = await mongoose.startSession();
  let payment;
  try {
    await session.withTransaction(async () => {
      const allocationResult = await allocateInterestFifo(loan._id, interestPaid, effectiveDate, session);

      const [created] = await Payment.create([buildPaymentDoc(allocationResult)], { session });
      payment = created;

      loan.principalOutstanding = newOutstanding;
      loan.totalPrincipalPaid += principalPaid;
      loan.totalInterestPaid += interestPaid;
      loan.lastPaymentDate = payment.paymentDate;
      await loan.save({ session });
    });
  } catch (err) {
    // Standalone MongoDB (no replica set) throws here because transactions
    // aren't supported — fall back to sequential writes.
    if (err.message?.includes('Transaction numbers') || err.codeName === 'IllegalOperation') {
      const allocationResult = await allocateInterestFifo(loan._id, interestPaid, effectiveDate, null);

      payment = await Payment.create(buildPaymentDoc(allocationResult));

      loan.principalOutstanding = newOutstanding;
      loan.totalPrincipalPaid += principalPaid;
      loan.totalInterestPaid += interestPaid;
      loan.lastPaymentDate = payment.paymentDate;
      await loan.save();
    } else {
      throw err;
    }
  } finally {
    session.endSession();
  }

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

  payment.receiptFile = {
    fileName: req.file.originalname,
    filePath: req.file.path.replace(/\\/g, '/'),
  };
  await payment.save();

  return new ApiResponse(200, 'Receipt uploaded successfully', { payment }).send(res, 200);
});

module.exports = { createPayment, getPayments, getPaymentById, updatePayment, uploadReceipt };
