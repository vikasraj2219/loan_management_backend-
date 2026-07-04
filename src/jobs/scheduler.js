const cron = require('node-cron');
const { generateMonthlyInterest, markOverdueLoans } = require('./interestJob');

/**
 * Schedules the monthly interest generation + overdue check.
 * Runs at INTEREST_CRON_HOUR:00 on INTEREST_CRON_DAY of every month
 * (both configurable via .env; defaults to the 1st at 01:00 server time).
 */
function startScheduler() {
  const day = parseInt(process.env.INTEREST_CRON_DAY, 10) || 1;
  const hour = parseInt(process.env.INTEREST_CRON_HOUR, 10) || 1;
  const pattern = `0 ${hour} ${day} * *`;

  cron.schedule(pattern, async () => {
    console.log(`[cron] Running monthly interest generation (pattern: ${pattern})`);
    try {
      const interestSummary = await generateMonthlyInterest();
      console.log('[cron] Interest generation summary:', interestSummary);

      const overdueSummary = await markOverdueLoans();
      console.log('[cron] Overdue check summary:', overdueSummary);
    } catch (err) {
      console.error('[cron] Monthly job failed:', err.message);
    }
  });

  console.log(`Monthly interest cron scheduled: "${pattern}" (day ${day}, hour ${hour})`);
}

module.exports = { startScheduler };
