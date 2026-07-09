const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ApiError = require('../utils/ApiError');
const { UPLOAD_ROOT, DOCUMENTS_SUBDIR } = require('../utils/fileStorage');

const DOCUMENTS_DIR = path.join(UPLOAD_ROOT, DOCUMENTS_SUBDIR);
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCUMENTS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base =
      path
        .basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9\-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80) || 'document';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${base}-${unique}${ext}`);
  },
});

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
