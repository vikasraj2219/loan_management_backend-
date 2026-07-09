const ActivityLog = require('../models/ActivityLog');

/**
 * Fire-and-forget audit logging. Deliberately swallows its own errors —
 * a failed log write must never fail the upload/delete/etc it's
 * describing. Callers don't (and shouldn't) await this for correctness,
 * only to keep tests deterministic if needed.
 */
async function logActivity({ action, entityType, entityId, performedBy, metadata }) {
  try {
    await ActivityLog.create({ action, entityType, entityId, performedBy, metadata });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[activityLog] failed to record entry:', err.message);
  }
}

module.exports = { logActivity };
