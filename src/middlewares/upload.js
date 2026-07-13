const multer = require('multer');
const ApiError = require('../utils/ApiError');

// Payment receipts, like documents, upload straight to Cloudinary — see
// src/utils/fileStorage.js. memoryStorage means the file never touches
// local disk; it's handed to Cloudinary as a buffer.
const storage = multer.memoryStorage();

const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(ApiError.badRequest('Unsupported file type. Only JPG, PNG and PDF are allowed.'), false);
  }
};

const maxSizeMb = parseInt(process.env.MAX_FILE_UPLOAD_MB, 10) || 5;

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxSizeMb * 1024 * 1024 },
});

module.exports = upload;
