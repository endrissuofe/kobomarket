const crypto = require('node:crypto');
const asyncHandler = require('../http/asyncHandler');
const { AppError, badRequest, conflict } = require('../errors');
const { logger } = require('../logger');
const { idempotencyRepository } = require('../../modules/idempotency/idempotency.repository');

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

/** JSON with object keys sorted at every level, so key order never matters. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const hashBody = (body) => crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');

/**
 * Idempotency-Key support for a POST endpoint. Use after requireAuth and
 * validate (the hash is of the validated body):
 *   router.post('/fund', requireAuth, validate(...), idempotent('wallet.fund'), handler)
 *
 * - No header: 400 IDEMPOTENCY_KEY_REQUIRED.
 * - First use: the handler runs; its JSON response (2xx or 4xx) is stored.
 *   A 5xx frees the key so the client can retry.
 * - Same key, same body, finished: the stored response is replayed.
 * - Same key, different body: 409 IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first request is still running: 409 REQUEST_IN_PROGRESS.
 * Keys are scoped per user and endpoint and expire after 24 hours.
 * The handler must answer with res.json().
 */
function idempotent(endpoint) {
  return asyncHandler(async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header', 400);
    }
    if (!KEY_PATTERN.test(key))
      throw badRequest('Idempotency-Key must be 1-255 printable characters');

    const scope = { key, userId: req.user.id, endpoint };
    const requestHash = hashBody(req.body);

    if (!(await idempotencyRepository.claim({ ...scope, requestHash }))) {
      const existing = await idempotencyRepository.find(scope);
      if (!existing) {
        // Released by a failed first attempt between our claim and read.
        throw conflict('REQUEST_IN_PROGRESS', 'Please retry this request');
      }
      if (existing.request_hash !== requestHash) {
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used with a different request body',
        );
      }
      if (existing.status !== 'COMPLETED') {
        throw conflict(
          'REQUEST_IN_PROGRESS',
          'A request with this Idempotency-Key is still running',
        );
      }
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.response_code).json(existing.response_body);
    }

    // Store the response before sending it, so a retry right after sees it.
    const send = res.json.bind(res);
    res.json = (body) => {
      const save =
        res.statusCode >= 500
          ? idempotencyRepository.release(scope)
          : idempotencyRepository.complete({
              ...scope,
              responseCode: res.statusCode,
              responseBody: body,
            });
      save
        .catch((err) => logger.error({ err, endpoint }, 'Could not store idempotent response'))
        .finally(() => send(body));
      return res;
    };
    return next();
  });
}

module.exports = { idempotent, canonicalJson, hashBody };
