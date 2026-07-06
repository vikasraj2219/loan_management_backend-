const cron = require('node-cron');
const { generateMonthlyInterest, markOverdueLoans } = require('./interestJob');

/**
 * Runs DAILY at INTEREST_CRON_HOUR:00 (default 01:00 server time) —
 * not once a month — because each loan bills on its own "money taken
 * day" (the day-of-month it was disbursed), not a single shared date.
 * generateMonthlyInterest() itself decides, per loan, whether today is
 * that loan's billing day; days that aren't anyone's billing day simply
 * skip every loan and do nothing.
 */
function startScheduler() {
  const hour = parseInt(process.env.INTEREST_CRON_HOUR, 10) || 1;
  const pattern = `0 ${hour} * * *`;

  cron.schedule(pattern, async () => {
    console.log(`[cron] Running daily interest check (pattern: ${pattern})`);
    try {
      const interestSummary = await generateMonthlyInterest();
      console.log('[cron] Interest generation summary:', interestSummary);

      const overdueSummary = await markOverdueLoans();
      console.log('[cron] Overdue check summary:', overdueSummary);
    } catch (err) {
      console.error('[cron] Daily job failed:', err.message);
    }
  });

  console.log(`Daily interest cron scheduled: "${pattern}" (hour ${hour}) — each loan bills on its own anniversary day`);
}

module.exports = { startScheduler };
