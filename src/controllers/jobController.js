const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const { generateMonthlyInterest, markOverdueLoans } = require('../jobs/interestJob');

/**
 * @desc  Manually trigger monthly interest generation for the current
 *        period. Idempotent — safe to call repeatedly; already-charged
 *        loans are skipped, not double-charged. Exists so this can be
 *        demonstrated/tested without waiting for the cron schedule.
 * @route POST /api/v1/jobs/generate-interest
 */
const runInterestGeneration = catchAsync(async (req, res) => {
  const summary = await generateMonthlyInterest();
  return new ApiResponse(200, 'Interest generation run complete', { summary }).send(res, 200);
});

/**
 * @desc  Manually trigger the overdue-loan check
 * @route POST /api/v1/jobs/check-overdue
 */
const runOverdueCheck = catchAsync(async (req, res) => {
  const summary = await markOverdueLoans();
  return new ApiResponse(200, 'Overdue check run complete', { summary }).send(res, 200);
});

module.exports = { runInterestGeneration, runOverdueCheck };
