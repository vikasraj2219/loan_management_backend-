const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const Payment = require('../models/Payment');
const { formatCurrencyPlain } = require('../utils/format');

/**
 * Shared filter builder + data fetch used by the JSON summary and all
 * three export formats, so a report always matches its export byte-for-byte.
 */
const fetchReportRows = async (query) => {
  const filter = {};
  if (query.borrower) filter.borrower = query.borrower;
  if (query.loan) filter.loan = query.loan;
  if (query.dateFrom || query.dateTo) {
    filter.paymentDate = {};
    if (query.dateFrom) filter.paymentDate.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.paymentDate.$lte = new Date(query.dateTo);
  }

  const payments = await Payment.find(filter)
    .populate({ path: 'borrower', select: 'name phone' })
    .populate({ path: 'loan', select: 'loanAmount interestRate status' })
    .sort({ paymentDate: 1 })
    .lean();

  return payments;
};

const summarize = (payments) => {
  const totalPrincipal = payments.reduce((sum, p) => sum + (p.principalPaid || 0), 0);
  const totalInterest = payments.reduce((sum, p) => sum + (p.interestPaid || 0), 0);
  return {
    paymentCount: payments.length,
    totalPrincipal,
    totalInterest,
    totalCollected: totalPrincipal + totalInterest,
  };
};

/**
 * @desc  Collection report summary (JSON) — date/borrower/loan filterable.
 * @route GET /api/v1/reports/collections
 */
const getCollectionReport = catchAsync(async (req, res) => {
  const payments = await fetchReportRows(req.query);
  const summary = summarize(payments);

  return new ApiResponse(200, 'Collection report generated successfully', { summary, payments }).send(res, 200);
});

/**
 * @desc  Export the collection report as a CSV file.
 * @route GET /api/v1/reports/export/csv
 */
const exportCsv = catchAsync(async (req, res) => {
  const payments = await fetchReportRows(req.query);

  const header = ['Date', 'Borrower', 'Phone', 'Principal Paid', 'Interest Paid', 'Mode', 'Reference', 'Outstanding After'];
  const escape = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const rows = payments.map((p) =>
    [
      new Date(p.paymentDate).toISOString().slice(0, 10),
      p.borrower?.name,
      p.borrower?.phone,
      p.principalPaid,
      p.interestPaid,
      p.paymentMode,
      p.referenceNumber || '',
      p.principalOutstandingAfter,
    ]
      .map(escape)
      .join(',')
  );

  const csv = [header.map(escape).join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="collection-report-${Date.now()}.csv"`);
  res.status(200).send(csv);
});

/**
 * @desc  Export the collection report as an Excel workbook.
 * @route GET /api/v1/reports/export/excel
 */
const exportExcel = catchAsync(async (req, res) => {
  const payments = await fetchReportRows(req.query);
  const summary = summarize(payments);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LoanFlow';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.addRows([
    ['Collection Report Summary'],
    [],
    ['Total Payments', summary.paymentCount],
    ['Total Principal Collected', summary.totalPrincipal],
    ['Total Interest Collected', summary.totalInterest],
    ['Total Collected', summary.totalCollected],
  ]);
  summarySheet.getColumn(1).width = 28;
  summarySheet.getRow(1).font = { bold: true, size: 14 };

  const sheet = workbook.addWorksheet('Payments');
  sheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Borrower', key: 'borrower', width: 24 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Principal Paid', key: 'principal', width: 16 },
    { header: 'Interest Paid', key: 'interest', width: 16 },
    { header: 'Mode', key: 'mode', width: 14 },
    { header: 'Reference', key: 'reference', width: 18 },
    { header: 'Outstanding After', key: 'outstanding', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  payments.forEach((p) => {
    sheet.addRow({
      date: new Date(p.paymentDate).toISOString().slice(0, 10),
      borrower: p.borrower?.name,
      phone: p.borrower?.phone,
      principal: p.principalPaid,
      interest: p.interestPaid,
      mode: p.paymentMode,
      reference: p.referenceNumber || '',
      outstanding: p.principalOutstandingAfter,
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="collection-report-${Date.now()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

/**
 * @desc  Export the collection report as a PDF document.
 * @route GET /api/v1/reports/export/pdf
 */
const exportPdf = catchAsync(async (req, res) => {
  const payments = await fetchReportRows(req.query);
  const summary = summarize(payments);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="collection-report-${Date.now()}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  doc.fontSize(18).text('Collection Report', { align: 'left' });
  doc.fontSize(9).fillColor('#666').text(`Generated on ${new Date().toLocaleString('en-IN')}`);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(11);
  doc.text(`Total Payments: ${summary.paymentCount}`);
  doc.text(`Total Principal Collected: ${formatCurrencyPlain(summary.totalPrincipal)}`);
  doc.text(`Total Interest Collected: ${formatCurrencyPlain(summary.totalInterest)}`);
  doc.text(`Total Collected: ${formatCurrencyPlain(summary.totalCollected)}`);
  doc.moveDown(1);

  const colX = [40, 120, 260, 340, 420, 490];
  const headers = ['Date', 'Borrower', 'Principal', 'Interest', 'Mode', 'Ref'];
  doc.fontSize(9).font('Helvetica-Bold');
  headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { continued: i < headers.length - 1 }));
  doc.moveDown(0.5);
  doc.font('Helvetica');

  payments.forEach((p) => {
    if (doc.y > 760) doc.addPage();
    const y = doc.y;
    doc.text(new Date(p.paymentDate).toISOString().slice(0, 10), colX[0], y, { width: 75 });
    doc.text(p.borrower?.name || '', colX[1], y, { width: 130 });
    doc.text(p.principalPaid ? formatCurrencyPlain(p.principalPaid) : '-', colX[2], y, { width: 70 });
    doc.text(p.interestPaid ? formatCurrencyPlain(p.interestPaid) : '-', colX[3], y, { width: 70 });
    doc.text(p.paymentMode || '', colX[4], y, { width: 60 });
    doc.text(p.referenceNumber || '-', colX[5], y, { width: 80 });
    doc.moveDown(0.3);
  });

  doc.end();
});

module.exports = { getCollectionReport, exportCsv, exportExcel, exportPdf };
