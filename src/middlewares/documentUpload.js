const multer = require('multer');
const ApiError = require('../utils/ApiError');

// Allowlisting known-good MIME types (rather than blacklisting bad ones) is
// what actually satisfies "prevent executable file uploads" — an .exe or
// .sh simply isn't in this list, so it's rejected the same way a truly
// unsupported type would be, with no special-casing needed.
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/zip',
  'application/x-zip-compressed',
]);

const MAX_FILE_SIZE_MB = 20;

// Files are held in memory (never written to local disk) and handed
// straight to Cloudinary as a buffer — see src/utils/fileStorage.js and
// src/services/cloudinaryService.js. This is the one piece of the stack
// that had to change for the Cloudinary migration; everything downstream
// (controller, model, frontend) works off the metadata fileStorage.js
// hands back, unaware of where the bytes actually went.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      ApiError.badRequest(
        `Unsupported file type "${file.mimetype}". Allowed: PDF, DOC, DOCX, XLS, XLSX, JPG, PNG, WEBP, ZIP.`
      ),
      false
    );
  }
};

const documentUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

module.exports = documentUpload;
