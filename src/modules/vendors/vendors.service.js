const { vendorsRepository } = require('./vendors.repository');
const { VENDOR_STATUS } = require('./vendor.model');
const { USER_STATUS } = require('../users/user.model');
const { slugify, withSuffix } = require('../../shared/text/slug');
const { conflict, forbidden, notFound } = require('../../shared/errors');

const SLUG_ATTEMPTS = 5;

// --- Response shapes. Bank details never leave in a public response. ---

function toPublic(vendor) {
  return {
    id: String(vendor._id),
    storeName: vendor.storeName,
    slug: vendor.slug,
    description: vendor.description,
    createdAt: vendor.createdAt,
  };
}

const maskAccountNumber = (n) => `******${n.slice(-4)}`;

/** The applicant's own view: status and masked bank details. */
function toOwner(vendor) {
  return {
    ...toPublic(vendor),
    userId: String(vendor.userId),
    status: vendor.status,
    rejectionReason: vendor.rejectionReason,
    reviewedAt: vendor.reviewedAt,
    bank: { ...vendor.bank, accountNumber: maskAccountNumber(vendor.bank.accountNumber) },
  };
}

const isDuplicate = (err, field) => err?.code === 11000 && err.keyPattern?.[field];

async function freeSlug(storeName) {
  const base = slugify(storeName);
  if (!(await vendorsRepository.slugExists(base))) return base;
  return withSuffix(base);
}

/**
 * Apply to become a vendor. One application per user. A rejected applicant
 * may apply again, which puts the same application back to PENDING.
 */
async function apply(user, { storeName, description = '', bank }) {
  if (user.status === USER_STATUS.FROZEN) {
    throw forbidden('Your account is frozen', 'ACCOUNT_FROZEN');
  }

  const existing = await vendorsRepository.findByUserId(user.id);
  if (existing && existing.status !== VENDOR_STATUS.REJECTED) {
    throw conflict('ALREADY_APPLIED', `You already have a ${existing.status.toLowerCase()} store`);
  }

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug =
      existing && slugify(storeName) === slugify(existing.storeName)
        ? existing.slug
        : await freeSlug(storeName);
    const fields = { storeName, description, bank, slug };
    try {
      if (existing) {
        const updated = await vendorsRepository.reapply(user.id, fields);
        // Someone (a second request) changed it in between.
        if (!updated) throw conflict('ALREADY_APPLIED', 'Your application has already changed');
        return toOwner(updated);
      }
      return toOwner((await vendorsRepository.create({ userId: user.id, ...fields })).toObject());
    } catch (err) {
      if (isDuplicate(err, 'userId')) throw conflict('ALREADY_APPLIED', 'You already have a store');
      if (!isDuplicate(err, 'slug')) throw err;
      // Slug taken by a concurrent application: try another.
    }
  }
  throw conflict('SLUG_UNAVAILABLE', 'Could not pick a unique store URL; try another name');
}

async function getMine(userId) {
  const vendor = await vendorsRepository.findByUserId(userId);
  if (!vendor) throw notFound('Vendor application');
  return toOwner(vendor);
}

/** Public store page: only approved stores exist publicly. */
async function getPublic(id) {
  const vendor = await vendorsRepository.findById(id);
  if (!vendor || vendor.status !== VENDOR_STATUS.APPROVED) throw notFound('Vendor');
  return toPublic(vendor);
}

module.exports = { vendorsService: { apply, getMine, getPublic }, toPublic, toOwner };
