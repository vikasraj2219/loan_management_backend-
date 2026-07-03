/**
 * Standardized success response envelope so every endpoint returns
 * the same shape: { success, message, data, meta? }
 */
class ApiResponse {
  constructor(statusCode, message, data = null, meta = undefined) {
    this.success = statusCode < 400;
    this.message = message;
    if (data !== null) this.data = data;
    if (meta !== undefined) this.meta = meta;
  }

  send(res, statusCode) {
    return res.status(statusCode || (this.success ? 200 : 500)).json(this);
  }
}

module.exports = ApiResponse;
