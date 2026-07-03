/**
 * Parses pagination + sorting query params into a normalized object.
 * Example: /api/v1/borrowers?page=2&limit=25&sort=-createdAt
 */
const getPaginationParams = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const skip = (page - 1) * limit;

  let sort = { createdAt: -1 };
  if (query.sort) {
    sort = {};
    query.sort.split(',').forEach((field) => {
      if (field.startsWith('-')) {
        sort[field.substring(1)] = -1;
      } else {
        sort[field] = 1;
      }
    });
  }

  return { page, limit, skip, sort };
};

/**
 * Builds a standard pagination meta object for API responses.
 */
const buildPaginationMeta = ({ total, page, limit }) => ({
  total,
  page,
  limit,
  totalPages: Math.max(Math.ceil(total / limit), 1),
  hasNextPage: page * limit < total,
  hasPrevPage: page > 1,
});

module.exports = { getPaginationParams, buildPaginationMeta };
