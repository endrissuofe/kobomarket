const { badRequest } = require('../errors');

// Opaque cursors for keyset pagination: base64url of a small JSON object such
// as { id } or { v: sortValue, id }. Clients pass back exactly what they got.

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/**
 * Fetch limit + 1 rows, return limit of them, and build nextCursor from the
 * last row returned when more exist.
 */
function paginate(rows, limit, toCursor) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore ? encodeCursor(toCursor(items[items.length - 1])) : null,
  };
}

module.exports = { encodeCursor, decodeCursor, paginate };
