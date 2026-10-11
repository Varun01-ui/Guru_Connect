import { z } from 'zod'

// M04 FR-4.2: per-key rules on top of the value_type check. Keys are only ever added by seeds/migrations, so this
// table lists the keys that need more than the generic rule for their type.
export const GROUP_ORDER = ['general', 'contact', 'legal', 'app_versions', 'limits'] as const

export type NumberRange = { min: number; max: number }
const DEFAULT_RANGE: NumberRange = { min: 0, max: 1_000_000 }

export const NUMBER_RANGES: Record<string, NumberRange> = {
  'limits.parent_max_children': { min: 1, max: 5 },
  'limits.institute_max_teachers': { min: 1, max: 200 },
  'limits.review_min_chars': { min: 10, max: 200 },
  'limits.featured_slots_per_city': { min: 0, max: 100 },
  'limits.student_trial_free_contacts': { min: 0, max: 50 },
  'notifications.daily_cap': { min: 0, max: 20 },
  'auth.otp_ttl_seconds': { min: 60, max: 900 },
  'auth.otp_resend_after_seconds': { min: 10, max: 300 },
  'auth.otp_max_per_hour': { min: 1, max: 20 },
  'search.default_radius_km': { min: 1, max: 100 },
  'search.max_radius_km': { min: 1, max: 500 },
  'reviews.edit_window_days': { min: 0, max: 365 },
  'leads.daily_limit': { min: 1, max: 100 },
  'demos.max_open_per_requester': { min: 1, max: 20 },
  'wallet.max_redeem_percent': { min: 0, max: 100 },
  'app.onboarding_version': { min: 1, max: 1000 },
}

export const rangeFor = (key: string): NumberRange => NUMBER_RANGES[key] ?? DEFAULT_RANGE

const weights = z.record(z.number().min(0).max(1)).refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.001, 'Weights must add up to 1.')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 21:30.')
const domain = z.string().trim().toLowerCase().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Enter a bare domain like guruconnect.in.')

// Keys of value_type "json" validated by their own schema (FR-4.2). Anything not listed accepts any JSON value.
export const JSON_SCHEMAS: Record<string, z.ZodType> = {
  'contact.grievance_officer': z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email() }).strict(),
  'institutes.rating_weights': weights,
  'recommendations.weights': weights,
  'complaints.safety_keywords': z.array(z.string().trim().min(1).max(40)).max(100),
  'banners.allowed_domains': z.array(domain).min(1, 'Keep at least one domain.').max(50),
  'notifications.quiet_hours': z.object({ start: hhmm, end: hhmm }).strict(),
  'app.maintenance_ends_at': z.union([z.null(), z.string().datetime({ offset: true })]),
}

export const MAINTENANCE_KEY = 'app.maintenance_mode'

// "app.*" keys change what every installed app does, so they always need a reason (section 5).
export const requiresReason = (key: string) => key.startsWith('app.')

// FR-4.2: the minimum supported version can never be above the latest one.
export const VERSION_PAIRS = [
  { min: 'app.android_min_version', latest: 'app.android_latest_version' },
  { min: 'app.ios_min_version', latest: 'app.ios_latest_version' },
] as const

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}
