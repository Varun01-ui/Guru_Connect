import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { containsContactInfo, maskContactInfo } from '../../../lib/contact.js'
import { conflictState, forbidden, notFound, validationFailed } from '../../../lib/errors.js'
import { resolveFee } from '../../../lib/pricing.js'
import type { FeeCode } from '../../../lib/pricing.js'
import { getSettingByKey } from '../bootstrap/bootstrap.repository.js'
import { DAY_MS, parentCoverage } from '../payments/payments.pricing.js'
import type { RequestContext } from '../student/student.service.js'

// M10 (parent) and M13 (student) share one implementation: the role comes from the token, `?role=` must agree with it.
export type SubRole = 'parent' | 'student'
export type SubContext = RequestContext & { userId: string; role: SubRole }

const PLAN_CODES: Record<SubRole, [FeeCode, FeeCode]> = {
  parent: ['PARENT_SUBSCRIPTION_MONTHLY', 'PARENT_SUBSCRIPTION_YEARLY'],
  student: ['STUDENT_SUBSCRIPTION_MONTHLY', 'STUDENT_SUBSCRIPTION_YEARLY'],
}
const LIVE = ['trial', 'active', 'grace', 'free_access'] as const

// `?role=` is fixed by the route, not user-editable: a mismatch with the token's role is simply not allowed.
export function resolveRole(tokenRole: string, queryRole: string | undefined): SubRole {
  if (tokenRole !== 'parent' && tokenRole !== 'student') throw forbidden("You can't do that.")
  if (queryRole && queryRole !== tokenRole) throw forbidden("You can't do that.")
  return tokenRole
}

const istDate = (d: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d)
const daysLeft = (end: Date | null, now: Date) => (end ? Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS)) : null)

// ---- GET /plans (BR-10.1, BR-13.1) ----

export async function listPlans(userId: string, role: SubRole) {
  // Trial-eligible only before the first-ever subscription row of this kind (BR-10.2).
  const had = await db.selectFrom('subscriptions').select('id').where('user_id', '=', userId).where('subscriber_type', '=', role).executeTakeFirst()
  const plans = []
  for (const code of PLAN_CODES[role]) {
    const c = await resolveFee(code)
    if (!c || !c.is_enabled) continue // a disabled plan is omitted, not greyed out
    const amount = Number(c.amount_paise)
    const yearly = c.billing_period === 'yearly'
    plans.push({
      feeCode: code,
      name: c.name,
      amountPaise: amount,
      billingPeriod: c.billing_period,
      validityDays: c.validity_days,
      trialDays: c.trial_days,
      trialEligible: !had && c.trial_days > 0,
      perMonthPaise: yearly ? Math.round(amount / 12) : amount,
      ...(yearly ? { bestValue: true } : {}),
    })
  }
  return plans
}

// ---- GET /subscriptions/current (BR-10.3, BR-13.2, BR-13.4) ----

export async function getCurrent(userId: string, role: SubRole) {
  const now = new Date()

  if (role === 'student') {
    const cover = await parentCoverage(userId)
    if (cover) {
      const s = cover.subscription
      const planName = (s.payment_configuration_id && (await db.selectFrom('payment_configurations').select('name').where('id', '=', s.payment_configuration_id).executeTakeFirst())?.name) || (await resolveFee(s.fee_code))?.name || 'Parent membership'
      return {
        status: 'covered_by_parent' as const,
        // Only the parent's first name and plan are shown to the student, never contact details.
        coveredBy: { parentId: cover.parentId, parentName: cover.parentFirstName, planName, until: (s.status === 'trial' ? s.trial_ends_at ?? s.ends_at : s.ends_at)?.toISOString() ?? null },
        canPurchase: false,
      }
    }
  }

  const rows = await db.selectFrom('subscriptions').selectAll().where('user_id', '=', userId).where('subscriber_type', '=', role).orderBy('created_at', 'desc').execute()
  const sub = rows.find((r) => (LIVE as readonly string[]).includes(r.status)) ?? rows[0]
  if (!sub) return { id: null, status: 'none' as const, canPurchase: true }

  const config = sub.payment_configuration_id
    ? await db.selectFrom('payment_configurations').select('name').where('id', '=', sub.payment_configuration_id).executeTakeFirst()
    : await resolveFee(sub.fee_code)
  const isTrial = sub.status === 'trial'
  const end = isTrial ? sub.trial_ends_at ?? sub.ends_at : sub.ends_at
  const canPurchase =
    sub.status === 'free_access' ? false : (sub.status === 'active' || sub.status === 'grace') && sub.ends_at ? sub.ends_at.getTime() - now.getTime() <= 30 * DAY_MS : true

  const base = {
    id: sub.id,
    feeCode: sub.fee_code,
    planName: config?.name ?? sub.fee_code,
    status: sub.status,
    startsAt: sub.starts_at.toISOString(),
    trialEndsAt: sub.trial_ends_at?.toISOString() ?? null,
    endsAt: isTrial ? null : sub.ends_at?.toISOString() ?? null,
    autoRenew: sub.auto_renew,
    daysLeft: daysLeft(end, now),
    canPurchase,
  }
  if (role === 'student' && isTrial) {
    // Used contacts are counted live from leads, never stored on the subscription (BR-13.2).
    const [limit, used] = await Promise.all([
      getSettingByKey('limits.student_trial_free_contacts'),
      db.selectFrom('leads').select(db.fn.countAll<number>().as('n')).where('requester_user_id', '=', userId).where('created_at', '>=', sub.starts_at).executeTakeFirst(),
    ])
    return { ...base, trialContactsUsed: Number(used?.n ?? 0), trialContactsLimit: Number(limit ?? 5) }
  }
  return base
}

// ---- shared write endpoints (BR-10.5, BR-10.6) ----

// Ownership is the token: someone else's subscription id is "no longer available", not "forbidden".
async function loadOwn(userId: string, role: SubRole, id: string) {
  const sub = await db.selectFrom('subscriptions').selectAll().where('id', '=', id).where('user_id', '=', userId).where('subscriber_type', '=', role).executeTakeFirst()
  if (!sub) throw notFound('This is no longer available.')
  return sub
}

const present = (s: { id: string; status: string; cancelled_at: Date | null; ends_at: Date | null; auto_renew: boolean }, message: string) => ({
  id: s.id,
  status: s.status,
  cancelledAt: s.cancelled_at?.toISOString() ?? null,
  endsAt: s.ends_at?.toISOString() ?? null,
  autoRenew: s.auto_renew,
  message,
})

export async function disableAutoRenew(ctx: SubContext, id: string) {
  const sub = await loadOwn(ctx.userId, ctx.role, id)
  if (!['trial', 'active', 'grace'].includes(sub.status)) throw conflictState('Only an active plan can have auto-renew changed.')

  await db.transaction().execute(async (trx) => {
    await trx.updateTable('subscriptions').set({ auto_renew: false }).where('id', '=', id).execute()
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.subscription_auto_renew_disabled',
      module: 'app.subscriptions',
      entityType: 'subscription',
      entityId: id,
      newValues: { subscriptionId: id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
  })
  const end = sub.status === 'trial' ? sub.trial_ends_at ?? sub.ends_at : sub.ends_at
  return present({ ...sub, auto_renew: false }, end ? `You'll keep access until ${istDate(end)}.` : "Auto-renew is off.")
}

export async function cancelSubscription(ctx: SubContext, id: string, body: { mode: 'at_period_end' | 'immediately'; reason?: string | null }) {
  const sub = await loadOwn(ctx.userId, ctx.role, id)
  const now = new Date()

  // A cancel that already happened (immediately, or at period end flagged by a user) is a conflict, so a second device refetches.
  if (sub.status === 'cancelled' || sub.cancelled_at || sub.cancelled_by_type === 'user') throw conflictState('This membership is already cancelled.')
  if (!['trial', 'active', 'grace'].includes(sub.status)) throw conflictState('This membership can no longer be cancelled.')

  if (body.mode === 'immediately' && now.getTime() - sub.starts_at.getTime() > DAY_MS) {
    throw validationFailed({ path: 'mode' }, 'You can only cancel immediately within 24 hours of subscribing.')
  }

  // Free text may contain a pasted phone number or link; mask it before it is stored.
  const reason = body.reason?.trim() ? (containsContactInfo(body.reason) ? maskContactInfo(body.reason.trim()) : body.reason.trim()) : null

  return db.transaction().execute(async (trx) => {
    const immediate = body.mode === 'immediately'
    const row = await trx
      .updateTable('subscriptions')
      .set({
        auto_renew: false,
        cancel_reason: reason,
        cancelled_by_type: 'user',
        ...(immediate ? { status: 'cancelled' as const, cancelled_at: now, ends_at: now > sub.starts_at ? now : sub.ends_at } : {}),
      })
      .where('id', '=', id)
      .returning(['id', 'status', 'cancelled_at', 'ends_at', 'auto_renew'])
      .executeTakeFirstOrThrow()
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.subscription_cancel_requested',
      module: 'app.subscriptions',
      entityType: 'subscription',
      entityId: id,
      newValues: { subscriptionId: id, mode: body.mode, reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    // A refund, if any, is requested through Module 45's flow, not created here.
    const end = sub.status === 'trial' ? sub.trial_ends_at ?? sub.ends_at : sub.ends_at
    return present(row, immediate ? 'Your membership has been cancelled.' : end ? `You'll keep access until ${istDate(end)}.` : 'Your membership will not renew.')
  })
}
