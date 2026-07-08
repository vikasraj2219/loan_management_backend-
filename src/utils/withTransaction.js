const mongoose = require('mongoose');

/**
 * Runs `work(session)` inside a MongoDB transaction when the connection
 * supports one (replica set / Atlas), and falls back to calling
 * `work(null)` directly on a standalone `mongod` (the common local-dev
 * setup, which doesn't support transactions at all). This is the same
 * opportunistic pattern used throughout this codebase for multi-document
 * writes — centralized here so every caller doesn't duplicate the
 * try/catch that detects "transactions aren't supported" vs. a real error.
 *
 * `work` must accept a session (or null) and pass it to every
 * `.save({ session })` / `.create([...], { session })` call it makes.
 */
async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (err.message?.includes('Transaction numbers') || err.codeName === 'IllegalOperation') {
      return work(null);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = withTransaction;
