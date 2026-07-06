const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Loan = require('../models/Loan');
const Borrower = require('../models/Borrower');
const { generateInterestRecordsBulk } = require('../jobs/interestJob');

/**
 * @desc  Manually generate every missing MonthlyInterest record, for one
 *        loan, one borrower's loans, or every active/overdue loan in the
 *        system — without waiting for month-end or the daily cron. Safe
 *        to run repeatedly: existing months are detected and skipped,
 *        never duplicated or overwritten (see interestJob.js).
 * @route POST /api/v1/interest/generate
 * @body  { loanId?, borrowerId?, generateTill? } — all optional
 */
const generateInterestRecords = catchAsync(async (req, res) => {
  const { loanId, borrowerId, generateTill } = req.body;

  if (loanId) {
    const exists = await Loan.exists({ _id: loanId });
    if (!exists) throw ApiError.notFound('Loan not found');
  }

  if (borrowerId) {
    const exists = await Borrower.exists({ _id: borrowerId });
    if (!exists) throw ApiError.notFound('Borrower not found');
  }

  const summary = await generateInterestRecordsBulk({ loanId, borrowerId, generateTill });

  return new ApiResponse(200, 'Monthly interest records generated successfully', { summary }).send(res, 200);
});

module.exports = { generateInterestRecords };
