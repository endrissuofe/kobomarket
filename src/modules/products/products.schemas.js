const { z } = require('zod');

// Money inputs are JSON integers in kobo. Strings and decimals are refused;
// nothing is coerced, so "1500" or 15.5 can never sneak in as a price.
const priceKobo = z
  .number({ invalid_type_error: 'Price must be a number in kobo' })
  .int('Price must be whole kobo (no decimals)')
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const stock = z.number().int('Stock must be a whole number').min(0).max(1_000_000);

const variant = z.object({
  sku: z.string().trim().min(1).max(64),
  attrs: z.record(z.string().trim().min(1).max(50)).default({}),
  priceKobo,
  stock,
});

const fields = {
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().max(5000),
  category: z.string().trim().toLowerCase().min(2).max(50),
  priceKobo,
  stock,
  variants: z.array(variant).max(50),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20),
  images: z.array(z.string().trim().url().max(500)).max(10),
  isActive: z.boolean(),
};

/**
 * Without variants, priceKobo and stock are required. With variants they are
 * derived (lowest price, total stock), so sending them is an error.
 * SKUs must be unique within a product.
 */
function checkVariants(body, ctx, { requireBase }) {
  const variants = body.variants;
  if (variants?.length) {
    for (const key of ['priceKobo', 'stock']) {
      if (body[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} comes from the variants; set it on each variant instead`,
        });
      }
    }
    const skus = variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants'],
        message: 'SKUs must be unique',
      });
    }
  } else if (requireBase) {
    for (const key of ['priceKobo', 'stock']) {
      if (body[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Required without variants',
        });
      }
    }
  }
}

const createBody = z
  .object({
    name: fields.name,
    description: fields.description.optional(),
    category: fields.category,
    priceKobo: fields.priceKobo.optional(),
    stock: fields.stock.optional(),
    variants: fields.variants.optional(),
    tags: fields.tags.optional(),
    images: fields.images.optional(),
    isActive: fields.isActive.optional(),
  })
  .strict()
  .superRefine((body, ctx) => checkVariants(body, ctx, { requireBase: true }));

const slugParams = z.object({ slug: z.string().trim().min(1).max(100) });

module.exports = { createBody, slugParams, fields, checkVariants };
