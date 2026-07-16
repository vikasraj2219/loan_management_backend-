const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const { getPaginationParams, buildPaginationMeta } = require('../utils/paginate');
const { allocateInterestFifo } = require('../services/interestAllocationService');
const { reversePaymentEffects, recalculateLastPaymentDate } = require('../services/paymentAdjustmentService');
const { logActivity } = require('../services/activityLogService');
const withTransaction = require('../utils/withTransaction');
const { uploadFile } = require('../utils/fileStorage');

/** Snapshot of a payment's editable fields, used for the before/after audit trail on edit. */
const snapshotPayment = (payment) => ({
  paymentDate: payment.paymentDate,
  principalPaid: payment.principalPaid,
  interestPaid: payment.interestPaid,
  paymentMode: payment.paymentMode,
  referenceNumber: payment.referenceNumber,
  remarks: payment.remarks,
});

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

  await logActivity({
    action: 'payment.create',
    entityType: 'Payment',
    entityId: payment._id,
    performedBy: req.user._id,
    metadata: { updated: snapshotPayment(payment) },
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
 * @desc  Edit a payment — date, principal/interest amounts, mode,
 *        reference number, or remarks. Admin only.
 *
 *        Amount/date edits are implemented as reverse-then-reapply: the
 *        payment's old effect on the loan and on every MonthlyInterest
 *        record it touched is fully undone (as if it had never been
 *        recorded), the new principal is validated against the
 *        now-reversed outstanding balance, and the new interest amount is
 *        re-run through the same FIFO allocation createPayment uses. This
 *        keeps edit and create sharing one allocation rule, and means a
 *        payment that used to clear 3 months but now clears 2 correctly
 *        frees the 3rd month back to pending — never a stale allocation.
 * @route PATCH /api/v1/payments/:id
 */
const updatePayment = catchAsync(async (req, res) => {
  const existing = await Payment.findById(req.params.id);
  if (!existing) throw ApiError.notFound('Payment not found');

  const loanForValidation = await Loan.findById(existing.loan);
  if (!loanForValidation) throw ApiError.notFound('Loan not found for this payment');

  const previousValues = snapshotPayment(existing);

  const nextPaymentDate = req.body.paymentDate !== undefined ? new Date(req.body.paymentDate) : existing.paymentDate;
  const nextPrincipalPaid = req.body.principalPaid !== undefined ? Number(req.body.principalPaid) : existing.principalPaid;
  const nextInterestPaid = req.body.interestPaid !== undefined ? Number(req.body.interestPaid) : existing.interestPaid;
  const nextPaymentMode = req.body.paymentMode !== undefined ? req.body.paymentMode : existing.paymentMode;
  const nextReferenceNumber = req.body.referenceNumber !== undefined ? req.body.referenceNumber : existing.referenceNumber;
  const nextRemarks = req.body.remarks !== undefined ? req.body.remarks : existing.remarks;

  if (nextPrincipalPaid <= 0 && nextInterestPaid <= 0) {
    throw ApiError.badRequest('At least one of principalPaid or interestPaid must be greater than 0');
  }
  if (nextPaymentDate < loanForValidation.loanDate) {
    throw ApiError.badRequest('Payment date cannot be before the loan issue date');
  }

  const { payment: updated, loan } = await withTransaction(async (session) => {
    const loanDoc = await Loan.findById(existing.loan).session(session || null);
    if (!loanDoc) throw ApiError.notFound('Loan not found for this payment');

    // Step 1: undo everything this payment did, as if it never existed —
    // frees up both the principal it covered and whichever months its
    // interest was allocated to.
    await reversePaymentEffects(existing, loanDoc, session);

    // Step 2: validate the new principal against the now-reversed balance.
    if (nextPrincipalPaid > loanDoc.principalOutstanding) {
      throw ApiError.badRequest(
        `Principal paid (${nextPrincipalPaid}) cannot exceed the outstanding principal (${loanDoc.principalOutstanding})`
      );
    }

    // Step 3: re-allocate the new interest amount FIFO against whatever is
    // pending now (this payment's own months included, since step 1 freed
    // them back up first).
    const allocationResult = await allocateInterestFifo(loanDoc._id, nextInterestPaid, nextPaymentDate, session);

    const newOutstanding = loanDoc.principalOutstanding - nextPrincipalPaid;

    existing.paymentDate = nextPaymentDate;
    existing.principalPaid = nextPrincipalPaid;
    existing.interestPaid = nextInterestPaid;
    existing.paymentMode = nextPaymentMode;
    existing.referenceNumber = nextReferenceNumber;
    existing.remarks = nextRemarks;
    existing.principalOutstandingAfter = newOutstanding;
    existing.interestAllocations = allocationResult.allocations;
    existing.unallocatedInterest = allocationResult.unallocated;
    await existing.save({ session });

    loanDoc.principalOutstanding = newOutstanding;
    loanDoc.totalPrincipalPaid += nextPrincipalPaid;
    loanDoc.totalInterestPaid += nextInterestPaid;
    loanDoc.lastPaymentDate = await recalculateLastPaymentDate(loanDoc._id, session);
    await loanDoc.save({ session });

    return { payment: existing, loan: loanDoc };
  });

  await logActivity({
    action: 'payment.update',
    entityType: 'Payment',
    entityId: updated._id,
    performedBy: req.user._id,
    metadata: { previous: previousValues, updated: snapshotPayment(updated) },
  });

  await updated.populate([
    { path: 'loan', select: 'loanAmount principalOutstanding interestRate status' },
    { path: 'borrower', select: 'name phone' },
  ]);

  return new ApiResponse(200, 'Payment updated successfully', { payment: updated, loan }).send(res, 200);
});

/**
 * @desc  Permanently delete a payment — admin only. Reverses its effect on
 *        the loan (principalOutstanding, totals, lastPaymentDate) and on
 *        every MonthlyInterest record it touched, so the loan ends up
 *        exactly as if this payment had never been recorded. Unlike
 *        MonthlyInterest records, payments have no independent value once
 *        removed, so this is a hard delete, not an archive.
 * @route DELETE /api/v1/payments/:id
 */
const deletePayment = catchAsync(async (req, res) => {
  const existing = await Payment.findById(req.params.id);
  if (!existing) throw ApiError.notFound('Payment not found');

  const previousValues = snapshotPayment(existing);

  const loan = await withTransaction(async (session) => {
    const loanDoc = await Loan.findById(existing.loan).session(session || null);
    if (!loanDoc) throw ApiError.notFound('Loan not found for this payment');

    await reversePaymentEffects(existing, loanDoc, session);
    loanDoc.lastPaymentDate = await recalculateLastPaymentDate(loanDoc._id, session, existing._id);
    await loanDoc.save({ session });

    await Payment.deleteOne({ _id: existing._id }, { session });

    return loanDoc;
  });

  await logActivity({
    action: 'payment.delete',
    entityType: 'Payment',
    entityId: existing._id,
    performedBy: req.user._id,
    metadata: { previous: previousValues },
  });

  return new ApiResponse(200, 'Payment deleted successfully', { deletedId: existing._id, loan }).send(res, 200);
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

module.exports = { createPayment, getPayments, getPaymentById, updatePayment, deletePayment, uploadReceipt };
