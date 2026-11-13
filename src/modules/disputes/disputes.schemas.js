const { z } = require('zod');
const { pageQuery } = require('../../shared/http/schemas');
const { DISPUTE_STATUS, RESOLUTIONS } = require('./disputes.constants');

// Evidence is text and/or image URLs.
const evidenceItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('image'), value: z.string().trim().url().max(500) }).strict(),
]);
const evidence = z.array(evidenceItem).max(10);

const openBody = z
  .object({ reason: z.string().trim().min(10).max(2000), evidence: evidence.default([]) })
  .strict();

const respondBody = z
  .object({ response: z.string().trim().min(10).max(2000), evidence: evidence.default([]) })
  .strict();

// refundKobo is required for a partial refund and refused otherwise. A full
// refund is always the whole sub-order; the service checks the upper bound.
const resolveBody = z
  .object({
    resolution: z.enum(Object.values(RESOLUTIONS)),
    refundKobo: z.number().int('refundKobo must be whole kobo').positive().optional(),
    note: z.string().trim().min(5, 'A note explaining the decision is required').max(2000),
  })
  .strict()
  .superRefine((body, ctx) => {
    const partial = body.resolution === RESOLUTIONS.PARTIAL_REFUND;
    if (partial && body.refundKobo === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['refundKobo'],
        message: 'Required for a partial refund',
      });
    }
    if (!partial && body.refundKobo !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['refundKobo'], message: 'Only for a partial refund' });
    }
  });

const disputeIdParams = z.object({ id: z.string().uuid('Invalid dispute id') });

const listQuery = pageQuery.extend({ status: z.enum(Object.values(DISPUTE_STATUS)).optional() });

module.exports = { openBody, respondBody, resolveBody, disputeIdParams, listQuery };
