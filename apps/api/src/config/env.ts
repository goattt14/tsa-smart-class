import 'dotenv/config';
import { z } from 'zod';

const boolish = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const isProd = process.env.NODE_ENV === 'production';
const secret = isProd ? z.string().min(32) : z.string().min(8).default('dev-only-insecure-secret-change-me');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  TZ: z.string().default('Asia/Kolkata'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  COOKIE_SECRET: secret,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  APP_NAME: z.string().default('The Scholastic Academy'),
  APP_WEB_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ALLOW_VERCEL_PREVIEWS: boolish(true),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  AI_PROVIDER: z.enum(['openai', 'anthropic', 'gemini', 'local', 'mock']).default('mock'),
  AI_TEXT_MODEL: z.string().optional(),
  AI_FAST_MODEL: z.string().optional(),
  AI_EMBEDDING_MODEL: z.string().optional(),
  AI_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2000),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().nonnegative().default(500_000),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  PGVECTOR_ENABLED: boolish(true),
  RAG_CHUNK_SIZE: z.coerce.number().int().positive().default(900),
  RAG_CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),
  RAG_TOP_K: z.coerce.number().int().positive().default(6),
  RAG_MIN_SCORE: z.coerce.number().default(0.25),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolish(true),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(900),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('TSA <no-reply@example.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMS_DRIVER: z.enum(['console', 'twilio', 'msg91']).default('console'),

  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  SEED_DEMO: boolish(true),
  DEMO_PASSWORD: z.string().default('Tsa@Demo2026'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to apps/api/.env and fill in the values.\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Origins allowed to call this API, parsed once at boot. */
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
