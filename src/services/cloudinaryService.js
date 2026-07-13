const cloudinary = require('../config/cloudinary');

const ROOT_FOLDER = 'loan-management';

/**
 * Maps a document's free-text category (see constants/documentCategories.js)
 * to one of the brief's fixed Cloudinary folders. Category is user-typeable
 * text, not an enum, so this is keyword matching with a safe fallback —
 * new/unexpected categories land in `other/` rather than erroring.
 */
function resolveFolder({ category = '', ownerField }) {
  const c = category.toLowerCase();

  if (/receipt/.test(c)) return 'receipts';
  if (/agreement|sanction|promissory/.test(c)) return 'agreements';
  if (/aadhaar|pan card|passport|voter|driving licen[cs]e|identity|photo/.test(c)) return 'identity-documents';
  if (ownerField === 'loan') return 'loans';
  if (ownerField === 'borrower') return 'borrowers';
  return 'other';
}

/** Images get Cloudinary's `image` pipeline (thumbnails, transforms); everything else is `raw`. */
function resolveResourceType(mimeType) {
  return mimeType.startsWith('image/') ? 'image' : 'raw';
}

/**
 * Uploads a buffer (from multer's memoryStorage) to Cloudinary via a
 * streamed upload — never touches local disk. Returns Cloudinary's raw
 * upload result. `unique_filename: true` plus Cloudinary's own random
 * suffixing is what satisfies "generate unique stored filenames" without
 * us managing that ourselves.
 */
function uploadBuffer(buffer, { category, ownerField, mimeType }) {
  const folder = resolveFolder({ category, ownerField });
  const resourceType = resolveResourceType(mimeType);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${ROOT_FOLDER}/${folder}`,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/** Deletes an asset from Cloudinary by public_id. Never throws — a failed cleanup should never block the DB operation that triggered it. */
async function destroyAsset(publicId, resourceType = 'raw') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cloudinaryService] failed to delete asset:', publicId, err.message);
  }
}

/**
 * Builds a delivery URL for a Cloudinary asset. `attachment: true` adds
 * Cloudinary's `fl_attachment` flag, which forces a browser download with
 * the given filename instead of rendering inline — this is what lets
 * downloads preserve the original filename directly from Cloudinary's URL,
 * with no file passing through our server. Cloudinary's attachment flag
 * filename can't contain slashes/spaces/most punctuation, so it's
 * sanitized down to a safe base name here rather than passed through raw.
 */
function buildDeliveryUrl(publicId, resourceType = 'raw', { attachment = false, filename } = {}) {
  let flags;
  if (attachment) {
    const safeName = filename
      ? filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 80)
      : '';
    flags = safeName ? `attachment:${safeName}` : 'attachment';
  }

  return cloudinary.url(publicId, {
    resource_type: resourceType,
    secure: true,
    flags,
  });
}

module.exports = { resolveFolder, resolveResourceType, uploadBuffer, destroyAsset, buildDeliveryUrl, ROOT_FOLDER };
