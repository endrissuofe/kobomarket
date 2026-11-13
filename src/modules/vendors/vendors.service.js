const { vendorsRepository } = require('./vendors.repository');
const { VENDOR_STATUS } = require('./vendor.model');
const { USER_STATUS, ROLES } = require('../users/user.model');
const { usersRepository } = require('../users/users.repository');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { slugify, withSuffix } = require('../../shared/text/slug');
const { badRequest, conflict, forbidden, notFound } = require('../../shared/errors');
const { objectId } = require('../../shared/http/schemas');

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

// --- Admin review ---

async function reviewConflict(id, action) {
  const current = await vendorsRepository.findById(id);
  if (!current) throw notFound('Vendor');
  return conflict(
    'INVALID_VENDOR_STATUS',
    `Cannot ${action} an application that is ${current.status}`,
    { status: current.status },
  );
}

/**
 * PENDING -> APPROVED, then grant the vendor role. The two writes are in
 * different collections and MongoDB here has no multi-document transaction,
 * so approve is safe to repeat: calling it on an APPROVED store re-grants the
 * role, which completes an approval that failed between the two writes.
 */
async function approve(adminId, vendorId) {
  let vendor = await vendorsRepository.transition(vendorId, {
    from: VENDOR_STATUS.PENDING,
    to: VENDOR_STATUS.APPROVED,
    reviewedBy: adminId,
  });
  if (!vendor) {
    const current = await vendorsRepository.findById(vendorId);
    if (current?.status !== VENDOR_STATUS.APPROVED) throw await reviewConflict(vendorId, 'approve');
    vendor = current;
  }
  await usersRepository.addRole(vendor.userId, ROLES.VENDOR);
  return toOwner(vendor);
}

async function reject(adminId, vendorId, { reason }) {
  const vendor = await vendorsRepository.transition(vendorId, {
    from: VENDOR_STATUS.PENDING,
    to: VENDOR_STATUS.REJECTED,
    reviewedBy: adminId,
    rejectionReason: reason,
  });
  if (!vendor) throw await reviewConflict(vendorId, 'reject');
  return toOwner(vendor);
}

/** Admin queue, oldest first. */
async function list({ status, limit, cursor }) {
  const after = decodeCursor(cursor);
  if (after && !objectId.safeParse(after.id).success) throw badRequest('Invalid cursor');
  const rows = await vendorsRepository.list({ status, afterId: after?.id, limit: limit + 1 });
  const page = paginate(rows, limit, (v) => ({ id: String(v._id) }));
  return { items: page.items.map(toOwner), nextCursor: page.nextCursor };
}

module.exports = {
  vendorsService: { apply, getMine, getPublic, approve, reject, list },
  toPublic,
  toOwner,
};
