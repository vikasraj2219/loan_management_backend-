const fs = require('fs');
const path = require('path');
const cloudinaryService = require('../services/cloudinaryService');

const UPLOAD_ROOT = process.env.UPLOAD_PATH || './uploads';

/**
 * Every document upload/delete/URL call in the app goes through this one
 * module — nowhere else touches Cloudinary or the filesystem directly for
 * documents. That's what made this migration possible without touching
 * the model, controller shape, or frontend: only this file (and the
 * multer storage engine in documentUpload.js) changed.
 *
 * New uploads go to Cloudinary exclusively (see business rules — no new
 * local storage). Documents uploaded before this migration keep working
 * via the `storageProvider === 'local'` branch in each function below,
 * until `npm run migrate:cloudinary` moves them over.
 */

/**
 * Uploads a multer memoryStorage file (has `.buffer`, never touched disk)
 * to Cloudinary and returns the metadata fields the Document model
 * expects. This is the only new-upload path in the app.
 */
async function uploadFile(multerFile, { category, ownerField }) {
  const result = await cloudinaryService.uploadBuffer(multerFile.buffer, {
    category,
    ownerField,
    mimeType: multerFile.mimetype,
  });

  return {
    originalFileName: multerFile.originalname,
    storedFileName: result.public_id.split('/').pop(),
    cloudinaryPublicId: result.public_id,
    secureUrl: result.secure_url,
    resourceType: result.resource_type,
    folder: result.folder,
    storageProvider: 'cloudinary',
    mimeType: multerFile.mimetype,
    extension: path.extname(multerFile.originalname).slice(1).toLowerCase(),
    fileSize: multerFile.size,
  };
}

/**
 * Deletes a document's underlying file: the Cloudinary asset for anything
 * uploaded after this migration, or the local file for anything uploaded
 * before it. Never throws — a failed cleanup should never block the DB
 * operation (delete, replace) that triggered it.
 */
async function deleteFile(document) {
  if (document.storageProvider === 'cloudinary' && document.cloudinaryPublicId) {
    await cloudinaryService.destroyAsset(document.cloudinaryPublicId, document.resourceType);
    return;
  }
  if (document.filePath) {
    try {
      const absolute = path.resolve(UPLOAD_ROOT, document.filePath);
      if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[fileStorage] failed to delete legacy local file:', err.message);
    }
  }
}

/** Resolves a legacy document's stored `filePath` to an absolute path on disk — only used by the local-fallback streaming path. */
function getAbsolutePath(relativeFilePath) {
  return path.resolve(UPLOAD_ROOT, relativeFilePath);
}

/**
 * Builds the URL a download/preview request should redirect to. Cloudinary
 * documents get a direct, secure Cloudinary URL (attachment-flagged for
 * downloads, so the original filename is preserved with no file passing
 * through our server). Legacy local documents return null, signaling the
 * caller to fall back to streaming the file from disk instead.
 */
function buildDeliveryUrl(document, { attachment = false } = {}) {
  if (document.storageProvider === 'cloudinary' && document.cloudinaryPublicId) {
    return cloudinaryService.buildDeliveryUrl(document.cloudinaryPublicId, document.resourceType, {
      attachment,
      filename: document.originalFileName,
    });
  }
  return null;
}

module.exports = { uploadFile, deleteFile, getAbsolutePath, buildDeliveryUrl, UPLOAD_ROOT };
