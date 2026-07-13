const cloudinary = require('cloudinary').v2;

/**
 * Single place the Cloudinary SDK is configured. Credentials come only
 * from environment variables — never hardcoded, never sent to the
 * frontend (the frontend never talks to Cloudinary directly; every
 * upload/delete/URL-signing goes through our own authenticated API).
 *
 * If these are missing, uploads will fail loudly at request time with a
 * clear Cloudinary error rather than silently writing nothing — there's
 * no local-disk fallback for new uploads (see business rules: "do not
 * store new documents in the local uploads folder").
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

if (process.env.NODE_ENV !== 'test' && (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)) {
  // eslint-disable-next-line no-console
  console.warn(
    '[cloudinary] CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not fully set — ' +
      'document uploads will fail until they are configured in .env'
  );
}

module.exports = cloudinary;
