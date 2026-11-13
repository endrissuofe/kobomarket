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

module.exports = { slugify, withSuffix };
