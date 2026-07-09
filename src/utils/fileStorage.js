const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = process.env.UPLOAD_PATH || './uploads';
const DOCUMENTS_SUBDIR = 'documents';

/**
 * Every path.join/fs call for uploaded documents goes through this module —
 * nowhere else in the app touches the filesystem directly for documents.
 * That's deliberate: migrating to S3, Cloudinary, or Azure Blob Storage
 * later means rewriting the functions in this one file (and swapping the
 * multer storage engine in documentUpload.js) — the controller, model, and
 * frontend never need to change, since they only ever deal with the
 * `fileUrl`/`filePath` strings this module hands back.
 */

/**
 * Turns a multer file object (already written to disk by
 * documentUpload.js's diskStorage engine) into the metadata fields the
 * Document model expects.
 */
function buildFileMetadata(multerFile) {
  const relativePath = path.posix.join(DOCUMENTS_SUBDIR, multerFile.filename);
  return {
    originalFileName: multerFile.originalname,
    storedFileName: multerFile.filename,
    filePath: relativePath,
    fileUrl: `/uploads/${relativePath}`,
    mimeType: multerFile.mimetype,
    extension: path.extname(multerFile.originalname).slice(1).toLowerCase(),
    fileSize: multerFile.size,
  };
}

/** Resolves a document's stored `filePath` to an absolute path on disk. */
function getAbsolutePath(relativeFilePath) {
  return path.resolve(UPLOAD_ROOT, relativeFilePath);
}

/** Deletes the physical file for a document, if it still exists. Never throws. */
function deleteFile(relativeFilePath) {
  try {
    const absolute = getAbsolutePath(relativeFilePath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (err) {
    // A missing/locked file should never block the DB operation that
    // triggered the delete (record deletion, replacement, etc).
    // eslint-disable-next-line no-console
    console.error('[fileStorage] failed to delete file:', err.message);
  }
}

module.exports = { buildFileMetadata, getAbsolutePath, deleteFile, DOCUMENTS_SUBDIR, UPLOAD_ROOT };
