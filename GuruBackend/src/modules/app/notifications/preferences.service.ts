import { z } from 'zod'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import type { AppRole } from '../../../lib/appJwt.js'
import { validationFailed } from '../../../lib/errors.js'
import type { RequestContext } from '../student/student.service.js'

export const CATEGORIES = ['account', 'verification', 'leads', 'demos', 'reviews', 'payments', 'subscription', 'referral', 'complaints', 'recommendations', 'announcements'] as const
export type Category = (typeof CATEGORIES)[number]

// BR-20.2: security and money alerts can never have push switched off.
export const LOCKED: readonly Category[] = ['account', 'payments']

const META: Record<Category, { label: string; description: string }> = {
  account: { label: 'Account', description: 'Security and account alerts' },
  verification: { label: 'Verification', description: 'Application and document updates' },
  leads: { label: 'Leads', description: 'New enquiries and messages' },
  demos: { label: 'Demos', description: 'Demo requests and reminders' },
  reviews: { label: 'Reviews', description: 'New reviews and replies' },
  payments: { label: 'Payments', description: 'Payments and receipts' },
  subscription: { label: 'Subscription', description: 'Plan and listing renewals' },
  referral: { label: 'Referrals', description: 'Referral rewards' },
  complaints: { label: 'Complaints', description: 'Updates on reports you filed' },
  recommendations: { label: 'Recommendations', description: 'Teachers and institutes picked for you' },
  announcements: { label: 'Announcements', description: 'News from GuruConnect' },
}

// BR-20.1: only the categories relevant to the caller's role. Teachers never see `recommendations` (learner-only);
// learners never see `verification`. The institute set is not spelled out in the spec; it follows the teacher set.
export function categoriesFor(role: AppRole): Category[] {
  const skip: Category[] = role === 'parent' || role === 'student' ? ['verification'] : ['recommendations']
  return CATEGORIES.filter((c) => !skip.includes(c))
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null)

export async function getPreferences(userId: string, role: AppRole) {
  const rows = await db.selectFrom('user_notification_preferences').selectAll().where('user_id', '=', userId).execute()
  const byCategory = new Map(rows.map((r) => [r.category, r]))
  return {
    items: categoriesFor(role).map((category) => {
      const r = byCategory.get(category)
      return {
        category,
        label: META[category].label,
        description: META[category].description,
        pushEnabled: r?.push_enabled ?? true, // a missing row means the defaults: push on, email off
        emailEnabled: r?.email_enabled ?? false,
        locked: LOCKED.includes(category),
        quietHoursStart: hhmm(r?.quiet_hours_start ?? null),
        quietHoursEnd: hhmm(r?.quiet_hours_end ?? null),
      }
    }),
  }
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

// Each row is validated by hand (not with zod's array error) so error paths read `items[2].pushEnabled`.
const rowSchema = z.object({
  category: z.string(),
  pushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  quietHoursStart: time.nullable().optional(),
  quietHoursEnd: time.nullable().optional(),
})
export const putPreferencesSchema = z.object({ items: z.array(z.unknown()).min(1).max(CATEGORIES.length) })

type Row = z.infer<typeof rowSchema>

export async function putPreferences(ctx: RequestContext & { userId: string; role: AppRole }, rawItems: unknown[]) {
  const allowed = categoriesFor(ctx.role)
  const errors: { path: string; message: string }[] = []
  const rows: Row[] = []
  const seen = new Set<string>()

  rawItems.forEach((raw, i) => {
    const parsed = rowSchema.safeParse(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push({ path: `items[${i}].${issue.path.join('.')}`, message: issue.path[0] === 'quietHoursStart' || issue.path[0] === 'quietHoursEnd' ? 'Set both a start and end time' : issue.message })
      return
    }
    const row = parsed.data
    if (!(allowed as string[]).includes(row.category)) return void errors.push({ path: `items[${i}].category`, message: 'Unknown category.' })
    if (seen.has(row.category)) return void errors.push({ path: `items[${i}].category`, message: 'Each category can only be sent once.' })
    seen.add(row.category)
    if ((LOCKED as string[]).includes(row.category) && !row.pushEnabled) return void errors.push({ path: `items[${i}].pushEnabled`, message: "Security and payment alerts can't be turned off." })
    // quiet hours: both set together or both null (undefined = leave as is)
    const start = row.quietHoursStart
    const end = row.quietHoursEnd
    if ((start === undefined) !== (end === undefined) || (start === null) !== (end === null)) {
      return void errors.push({ path: `items[${i}].quietHoursStart`, message: 'Set both a start and end time' })
    }
    rows.push(row)
  })

  if (errors.length > 0) {
    const first = errors[0]!
    throw validationFailed(errors.length === 1 ? { path: first.path } : errors, first.message.endsWith('.') ? first.message : `${first.message}.`)
  }

  await db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('user_notification_preferences').selectAll().where('user_id', '=', ctx.userId).execute()
    const current = new Map(existing.map((e) => [e.category, e]))
    for (const row of rows) {
      const cur = current.get(row.category)
      const set = { push_enabled: row.pushEnabled, email_enabled: row.emailEnabled, ...(row.quietHoursStart !== undefined ? { quiet_hours_start: row.quietHoursStart, quiet_hours_end: row.quietHoursEnd ?? null } : {}) }
      await trx
        .insertInto('user_notification_preferences')
        .values({ user_id: ctx.userId, category: row.category, ...set })
        .onConflict((oc) => oc.columns(['user_id', 'category']).doUpdateSet(set))
        .execute()

      const changed =
        !cur ? row.pushEnabled !== true || row.emailEnabled !== false || row.quietHoursStart != null : cur.push_enabled !== row.pushEnabled || cur.email_enabled !== row.emailEnabled || (row.quietHoursStart !== undefined && (hhmm(cur.quiet_hours_start) !== row.quietHoursStart || hhmm(cur.quiet_hours_end) !== (row.quietHoursEnd ?? null)))
      if (changed) {
        await audit(trx, {
          actorType: 'app_user',
          actorId: ctx.userId,
          action: 'app.notification_preference_updated',
          module: 'app.notifications',
          entityType: 'notification_preference',
          entityId: ctx.userId,
          newValues: { category: row.category, pushEnabled: row.pushEnabled, emailEnabled: row.emailEnabled },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          requestId: ctx.requestId,
        })
      }
    }
  })
  return getPreferences(ctx.userId, ctx.role)
}
