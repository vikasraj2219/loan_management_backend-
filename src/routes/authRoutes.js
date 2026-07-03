const express = require('express');
const rateLimit = require('express-rate-limit');
const { register, login, refresh, getMe, updatePassword } = require('../controllers/authController');
const { registerRules, loginRules, updatePasswordRules } = require('../validators/authValidator');
const validate = require('../middlewares/validate');
const { protect } = require('../middlewares/auth');

const router = express.Router();

// Stricter limiter on auth endpoints to slow down brute-force attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// POST /auth/register - register a new user (first user becomes admin)
router.post('/register', authLimiter, registerRules, validate, register);

// POST /auth/login - login with email & password
router.post('/login', authLimiter, loginRules, validate, login);

// POST /auth/refresh - exchange refresh token for new access token
router.post('/refresh', refresh);

// GET /auth/me - get current authenticated user
router.get('/me', protect, getMe);

// PATCH /auth/update-password - change password
router.patch('/update-password', protect, updatePasswordRules, validate, updatePassword);

module.exports = router;
