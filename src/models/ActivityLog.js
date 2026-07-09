const mongoose = require('mongoose');

/**
 * A minimal, append-only audit trail. Currently written to by the
 * document module (upload/edit/replace/download/delete, per the business
 * rule that every one of those actions must be logged) — the shape is
 * generic on purpose so other modules can log into the same collection
 * later without a new model.
 */
const activityLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true, // e.g. 'document.upload', 'document.delete', 'document.download'
      index: true,
    },
    entityType: {
      type: String,
      required: true, // e.g. 'Document'
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

activityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
