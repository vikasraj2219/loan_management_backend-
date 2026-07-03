const jwt = require('jsonwebtoken');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const User = require('../models/User');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateToken');

/**
 * @desc  Register a new user (admin only in production; open for first-run setup)
 * @route POST /api/v1/auth/register
 */
const register = catchAsync(async (req, res) => {
  const { name, email, password, role } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('A user with this email already exists');

  // Only an authenticated admin can create another admin/staff account.
  // For the very first user in an empty system, allow self-registration as admin.
  const userCount = await User.countDocuments();
  const assignedRole = userCount === 0 ? 'admin' : role || 'staff';

  const user = await User.create({ name, email, password, role: assignedRole });

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  return new ApiResponse(201, 'User registered successfully', {
    user,
    accessToken,
    refreshToken,
  }).send(res, 201);
});

/**
 * @desc  Login with email & password
 * @route POST /api/v1/auth/login
 */
const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password +isActive');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated. Contact an administrator.');
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  return new ApiResponse(200, 'Login successful', {
    user,
    accessToken,
    refreshToken,
  }).send(res, 200);
});

/**
 * @desc  Exchange a valid refresh token for a new access token
 * @route POST /api/v1/auth/refresh
 */
const refresh = catchAsync(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw ApiError.badRequest('Refresh token is required');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(decoded.id);
  if (!user || !user.isActive) throw ApiError.unauthorized('User no longer exists or is inactive');

  const accessToken = generateAccessToken(user._id, user.role);
  return new ApiResponse(200, 'Token refreshed', { accessToken }).send(res, 200);
});

/**
 * @desc  Get currently authenticated user's profile
 * @route GET /api/v1/auth/me
 */
const getMe = catchAsync(async (req, res) => {
  return new ApiResponse(200, 'Current user fetched', { user: req.user }).send(res, 200);
});

/**
 * @desc  Update current user's password
 * @route PATCH /api/v1/auth/update-password
 */
const updatePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(currentPassword))) {
    throw ApiError.unauthorized('Current password is incorrect');
  }

  user.password = newPassword;
  await user.save();

  const accessToken = generateAccessToken(user._id, user.role);
  return new ApiResponse(200, 'Password updated successfully', { accessToken }).send(res, 200);
});

module.exports = { register, login, refresh, getMe, updatePassword };
