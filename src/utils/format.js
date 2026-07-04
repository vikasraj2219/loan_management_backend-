/**
 * Plain-text currency formatting for PDF generation (pdfkit has no
 * built-in Intl support in some environments, and the ₹ glyph needs a
 * font that embeds it — Rs. is a safer default for exported documents).
 */
const formatCurrencyPlain = (value = 0) => `Rs. ${Math.round(value || 0).toLocaleString('en-IN')}`;

module.exports = { formatCurrencyPlain };
