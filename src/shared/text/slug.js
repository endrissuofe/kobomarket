const crypto = require('node:crypto');

/** "Ada's Fábrics & Co." -> "adas-fabrics-co". */
function slugify(text, maxLength = 60) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Append a short random suffix, used when a slug is already taken. */
function withSuffix(slug) {
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

const isDuplicateSlug = (err) => err?.code === 11000 && err.keyPattern?.slug;

/**
 * Create a document under a unique slug made from text. Tries the plain slug
 * first, then suffixed ones; a duplicate-key error from a concurrent insert
 * just moves on to the next attempt.
 *   createWithUniqueSlug(name, { exists: (s) => Repo.slugExists(s), create: (slug) => Repo.create({ ...fields, slug }) })
 */
async function createWithUniqueSlug(text, { exists, create, attempts = 5 }) {
  const base = slugify(text);
  for (let i = 0; i < attempts; i += 1) {
    const slug = i === 0 && !(await exists(base)) ? base : withSuffix(base);
    try {
      return await create(slug);
    } catch (err) {
      if (!isDuplicateSlug(err)) throw err;
    }
  }
  const err = new Error('Could not find a free slug');
  err.code = 'SLUG_UNAVAILABLE';
  throw err;
}

module.exports = { slugify, withSuffix, createWithUniqueSlug };
