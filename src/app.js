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

// --- Static files (uploaded documents) ---
app.use('/uploads', express.static('uploads'));

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
