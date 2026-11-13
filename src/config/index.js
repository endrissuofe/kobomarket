require('./loadEnv');
const { z } = require('zod');

// Validate every env var once at boot. A missing secret stops the app here,
// not halfway through a request.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default(''),

  MONGO_URI: z.string().min(1),
  // App traffic uses the pooled URL. Migrations use the direct (unpooled) URL
  // when one is set, as Neon recommends; locally both can be the same.
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  PAYMENT_PROVIDER: z.enum(['paystack', 'mock']).default('mock'),
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: z.string().default(''),

  DEFAULT_COMMISSION_BPS: z.coerce.number().int().min(0).max(10000).default(500),
  ESCROW_TIMEOUT_HOURS: z.coerce.number().int().positive().default(72),
  PAYOUT_MIN_KOBO: z.coerce.number().int().positive().default(100000),
});

const MOCK_PAYSTACK_SECRET = 'sk_test_kobomarket_mock_provider';

const withRules = schema.superRefine((env, ctx) => {
  if (env.PAYMENT_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['PAYSTACK_SECRET_KEY'],
      message: 'Required when PAYMENT_PROVIDER=paystack (use a test-mode sk_test_ key)',
    });
  }
});

const parsed = withRules.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

module.exports = {
  env: env.NODE_ENV,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  mongoUri: env.MONGO_URI,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  },
  payments: {
    provider: env.PAYMENT_PROVIDER,
    // The mock provider signs its webhooks too; without a key it uses a fixed
    // test secret so signature checks still run in development and tests.
    paystackSecret:
      env.PAYSTACK_SECRET_KEY || (env.PAYMENT_PROVIDER === 'mock' ? MOCK_PAYSTACK_SECRET : ''),
    paystackBaseUrl: env.PAYSTACK_BASE_URL,
    callbackUrl: env.PAYSTACK_CALLBACK_URL,
  },
  // Defaults only. Live values come from the settings table (admin-editable).
  business: {
    commissionBps: env.DEFAULT_COMMISSION_BPS,
    escrowTimeoutHours: env.ESCROW_TIMEOUT_HOURS,
    payoutMinKobo: env.PAYOUT_MIN_KOBO,
  },
};
