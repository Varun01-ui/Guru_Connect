import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_DATABASE: z.string().min(1),
  DB_USERNAME: z.string().min(1),
  DB_PASSWORD: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16).default('dev-only-access-secret-change-me'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_COOKIE_NAME: z.string().default('gc_admin_rt'),
  CSRF_COOKIE_NAME: z.string().default('gc_admin_csrf'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_TOKEN_TTL_DAYS_REMEMBER: z.coerce.number().int().positive().default(30),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),

  // Redis (rate limits, revoked-session deny-list, BullMQ). Optional: without it the API falls back to
  // in-process rate limiting and the Postgres session check (correct, just single-process).
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  REDIS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Outbound email. Without SMTP_HOST, mails are logged to the console (dev) — same shape as the real flow.
  ADMIN_PORTAL_URL: z.string().default(process.env.CORS_ORIGIN ?? 'http://localhost:5173'),
  MAIL_FROM: z.string().default('GuruConnect Admin <no-reply@guruconnect.in>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  // Mobile app API (/api/v1/app) — separate JWT audience/secret from the admin portal on purpose,
  // so a leaked admin token can never be replayed against app endpoints or vice versa.
  APP_JWT_SECRET: z.string().min(16).default('dev-only-app-jwt-secret-change-me'),
  APP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  APP_REGISTRATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  OTP_PEPPER: z.string().min(8).default('dev-only-otp-pepper-change-me'),
  // HMAC key for Aadhaar/PAN duplicate-detection hashes (M15 BR-15.2). Belongs in a KMS in production.
  DOC_HASH_KEY: z.string().min(16).default('dev-only-doc-hash-key-change-me'),
  // Razorpay. No account exists yet: the fake gateway in lib/razorpay.ts is used. Only the key id ever reaches the app.
  RAZORPAY_KEY_ID: z.string().default('rzp_test_devkey000000'),
  RAZORPAY_KEY_SECRET: z.string().min(8).default('dev-only-razorpay-secret'),
  GOOGLE_OAUTH_CLIENT_IDS: z.string().default(''),
  // File storage (M00 uploads). Only the local-disk driver exists: there is no R2/S3 account yet, so presigned URLs
  // point back at this API (see lib/storage.ts). Unset, CDN_BASE_URL falls back to the API's own /cdn route in
  // development and to https://cdn.guruconnect.in in production.
  API_PUBLIC_URL: z.string().optional(),
  CDN_BASE_URL: z.string().optional(),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  STORAGE_SIGNING_SECRET: z.string().min(16).default('dev-only-storage-signing-secret'),
  LEGAL_TERMS_VERSION: z.string().default('terms-2026-01'),
  LEGAL_PRIVACY_VERSION: z.string().default('privacy-2026-01'),
})

const parsedEnv = envSchema.parse(process.env)
const apiPublicUrl = (parsedEnv.API_PUBLIC_URL || `http://localhost:${parsedEnv.PORT}`).replace(/\/$/, '')

export const env = {
  ...parsedEnv,
  API_PUBLIC_URL: apiPublicUrl,
  CDN_BASE_URL: (parsedEnv.CDN_BASE_URL || (parsedEnv.NODE_ENV === 'production' ? 'https://cdn.guruconnect.in' : `${apiPublicUrl}/cdn`)).replace(/\/$/, ''),
}
export type Env = typeof env

export const googleOAuthClientIds = env.GOOGLE_OAUTH_CLIENT_IDS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
