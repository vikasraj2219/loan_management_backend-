const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const notFound = require('./middlewares/notFound');

const app = express();

// --- Core middleware ---
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NOTE: uploaded files are intentionally NOT served via express.static.
// Every file (documents, receipts) has its own authenticated endpoint
// (see /documents/download/:id and /documents/preview/:id) that streams
// it from disk after checking the request's JWT — a blanket static mount
// here would let anyone with a guessed/leaked fileUrl bypass that check
// entirely, which violates the "protect download endpoints with
// authentication" requirement. If a future feature needs public files
// (e.g. a logo), mount a separate, clearly-scoped static path for it.

// --- Request logging ---
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// --- API routes ---
const apiPrefix = process.env.API_PREFIX || '/api/v1';
app.use(apiPrefix, routes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Loan & Interest Management System API' });
});

// --- 404 + error handling (must be last) ---
app.use(notFound);
app.use(errorHandler);

module.exports = app;
