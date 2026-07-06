const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const Borrower = require('../models/Borrower');
const Loan = require('../models/Loan');
const Payment = require('../models/Payment');
const MonthlyInterest = require('../models/MonthlyInterest');

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * @desc  Top-level summary powering the Dashboard stat cards.
 * @route GET /api/v1/dashboard/summary
 */
const getSummary = catchAsync(async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const monthStart = startOfMonth(now);

  const [
    totalBorrowers,
    activeLoans,
    closedLoans,
    overdueLoans,
    loanAggregates,
    todaysCollectionAgg,
    monthlyCollectionAgg,
    pendingInterestAgg,
    overdueInterestAgg,
  ] = await Promise.all([
    Borrower.countDocuments({ status: 'active' }),
    Loan.countDocuments({ status: 'active' }),
    Loan.countDocuments({ status: 'closed' }),
    Loan.countDocuments({ status: 'overdue' }),
    Loan.aggregate([
      {
        $group: {
          _id: null,
          totalAmountLent: { $sum: '$loanAmount' },
          outstandingPrincipal: {
            $sum: { $cond: [{ $in: ['$status', ['active', 'overdue']] }, '$principalOutstanding', 0] },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { paymentDate: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: { $add: ['$principalPaid', '$interestPaid'] } } } },
    ]),
    Payment.aggregate([
      { $match: { paymentDate: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: { $add: ['$principalPaid', '$interestPaid'] } } } },
    ]),
    // Pending Interest Tracking cards — computed dynamically from the
    // MonthlyInterest ledger every time, never from a cached total.
    MonthlyInterest.aggregate([
      { $match: { status: { $ne: 'paid' } } },
      {
        $group: {
          _id: null,
          totalPendingInterest: { $sum: '$pendingAmount' },
          totalPendingMonths: { $sum: 1 },
          borrowers: { $addToSet: '$borrower' },
        },
      },
    ]),
    MonthlyInterest.aggregate([
      { $match: { status: { $ne: 'paid' }, dueDate: { $lt: now } } },
      {
        $group: {
          _id: null,
          overdueInterestAmount: { $sum: '$pendingAmount' },
          loans: { $addToSet: '$loan' },
        },
      },
    ]),
  ]);

  const aggregates = loanAggregates[0] || { totalAmountLent: 0, outstandingPrincipal: 0 };
  const pendingInterest = pendingInterestAgg[0] || { totalPendingInterest: 0, totalPendingMonths: 0, borrowers: [] };
  const overdueInterest = overdueInterestAgg[0] || { overdueInterestAmount: 0, loans: [] };

  return new ApiResponse(200, 'Dashboard summary fetched successfully', {
    totalBorrowers,
    activeLoans,
    closedLoans,
    overdueLoans,
    totalAmountLent: aggregates.totalAmountLent,
    outstandingPrincipal: aggregates.outstandingPrincipal,
    todaysCollection: todaysCollectionAgg[0]?.total || 0,
    monthlyCollection: monthlyCollectionAgg[0]?.total || 0,
    // Pending Interest Tracking
    totalPendingInterest: Math.round(pendingInterest.totalPendingInterest),
    totalPendingInterestMonths: pendingInterest.totalPendingMonths,
    borrowersWithPendingInterest: pendingInterest.borrowers.length,
    overdueInterestAmount: Math.round(overdueInterest.overdueInterestAmount),
    loansWithOverdueInterest: overdueInterest.loans.length,
  }).send(res, 200);
});

/**
 * @desc  Monthly collection totals for the last N months (default 6).
 * @route GET /api/v1/dashboard/collection-trend?months=6
 */
const getCollectionTrend = catchAsync(async (req, res) => {
  const months = Math.min(parseInt(req.query.months, 10) || 6, 24);
  const from = new Date();
  from.setMonth(from.getMonth() - (months - 1));
  from.setDate(1);
  from.setHours(0, 0, 0, 0);

  const rows = await Payment.aggregate([
    { $match: { paymentDate: { $gte: from } } },
    {
      $group: {
        _id: { year: { $year: '$paymentDate' }, month: { $month: '$paymentDate' } },
        total: { $sum: { $add: ['$principalPaid', '$interestPaid'] } },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  // Build a complete series (months with zero collections still appear).
  const series = [];
  const cursor = new Date(from);
  for (let i = 0; i < months; i += 1) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const match = rows.find((r) => r._id.year === year && r._id.month === month);
    series.push({
      label: cursor.toLocaleString('en-US', { month: 'short' }),
      year,
      month,
      total: match?.total || 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return new ApiResponse(200, 'Collection trend fetched successfully', { series }).send(res, 200);
});

/**
 * @desc  Principal vs interest collected per month for the last N months.
 * @route GET /api/v1/dashboard/principal-interest-trend?months=6
 */
const getPrincipalInterestTrend = catchAsync(async (req, res) => {
  const months = Math.min(parseInt(req.query.months, 10) || 6, 24);
  const from = new Date();
  from.setMonth(from.getMonth() - (months - 1));
  from.setDate(1);
  from.setHours(0, 0, 0, 0);

  const rows = await Payment.aggregate([
    { $match: { paymentDate: { $gte: from } } },
    {
      $group: {
        _id: { year: { $year: '$paymentDate' }, month: { $month: '$paymentDate' } },
        principal: { $sum: '$principalPaid' },
        interest: { $sum: '$interestPaid' },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const series = [];
  const cursor = new Date(from);
  for (let i = 0; i < months; i += 1) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const match = rows.find((r) => r._id.year === year && r._id.month === month);
    series.push({
      label: cursor.toLocaleString('en-US', { month: 'short' }),
      year,
      month,
      principal: match?.principal || 0,
      interest: match?.interest || 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return new ApiResponse(200, 'Principal vs interest trend fetched successfully', { series }).send(res, 200);
});

/**
 * @desc  Loan status distribution (counts + percentages).
 * @route GET /api/v1/dashboard/loan-status-distribution
 */
const getLoanStatusDistribution = catchAsync(async (req, res) => {
  const rows = await Loan.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  const distribution = ['active', 'closed', 'overdue'].map((status) => {
    const row = rows.find((r) => r._id === status);
    const count = row?.count || 0;
    return { status, count, percentage: total ? Math.round((count / total) * 100) : 0 };
  });

  return new ApiResponse(200, 'Loan status distribution fetched successfully', { distribution, total }).send(res, 200);
});

/**
 * @desc  Most recent payments across all loans.
 * @route GET /api/v1/dashboard/recent-payments?limit=5
 */
const getRecentPayments = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const payments = await Payment.find()
    .populate({ path: 'borrower', select: 'name phone' })
    .sort({ paymentDate: -1 })
    .limit(limit)
    .lean();

  return new ApiResponse(200, 'Recent payments fetched successfully', { payments }).send(res, 200);
});

/**
 * @desc  Loans currently overdue, most overdue first.
 * @route GET /api/v1/dashboard/overdue-loans?limit=5
 */
const getOverdueLoans = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const loans = await Loan.find({ status: 'overdue' })
    .populate({ path: 'borrower', select: 'name phone' })
    .sort({ dueDate: 1 })
    .limit(limit)
    .lean();

  const now = Date.now();
  const withDaysOverdue = loans.map((loan) => ({
    ...loan,
    daysOverdue: loan.dueDate ? Math.floor((now - new Date(loan.dueDate).getTime()) / 86400000) : null,
  }));

  return new ApiResponse(200, 'Overdue loans fetched successfully', { loans: withDaysOverdue }).send(res, 200);
});

/**
 * @desc  Top borrowers by total amount lent.
 * @route GET /api/v1/dashboard/top-borrowers?limit=5
 */
const getTopBorrowers = catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);

  const rows = await Loan.aggregate([
    {
      $group: {
        _id: '$borrower',
        totalLent: { $sum: '$loanAmount' },
        outstanding: { $sum: '$principalOutstanding' },
        loanCount: { $sum: 1 },
      },
    },
    { $sort: { totalLent: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'borrowers',
        localField: '_id',
        foreignField: '_id',
        as: 'borrower',
      },
    },
    { $unwind: '$borrower' },
    {
      $project: {
        _id: 0,
        borrowerId: '$_id',
        name: '$borrower.name',
        phone: '$borrower.phone',
        totalLent: 1,
        outstanding: 1,
        loanCount: 1,
      },
    },
  ]);

  return new ApiResponse(200, 'Top borrowers fetched successfully', { borrowers: rows }).send(res, 200);
});

module.exports = {
  getSummary,
  getCollectionTrend,
  getPrincipalInterestTrend,
  getLoanStatusDistribution,
  getRecentPayments,
  getOverdueLoans,
  getTopBorrowers,
};
