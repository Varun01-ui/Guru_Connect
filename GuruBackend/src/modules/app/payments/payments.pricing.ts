import type { Kysely } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'
import type { AppRole } from '../../../lib/appJwt.js'
import { ApiError, conflictState, forbidden, validationFailed } from '../../../lib/errors.js'
import { computeAmounts } from '../../../lib/money.js'
import type { FeeAmounts } from '../../../lib/money.js'
import { FEE_CODES, resolveFee } from '../../../lib/pricing.js'
import type { FeeCode } from '../../../lib/pricing.js'
import { getSettingByKey } from '../bootstrap/bootstrap.repository.js'

type Executor = Kysely<DB>

export const DAY_MS = 24 * 60 * 60 * 1000
const QUEUE_WINDOW_DAYS = 30

export type Payer = { userId: string; role: AppRole }
export type PaymentContext = { leadId?: string | null; renewal?: boolean | null }

// What M10 / M13 / M15 can buy through this module. The other fee codes (institute registration, premium, featured,
// contact unlock) depend on modules that are not built yet (M22, M44, M37) and are refused as "not supported yet".
type FeeRule = { role: AppRole; purpose: 'teacher_registration' | 'subscription'; payerType: 'teacher' | 'parent' | 'student'; subscriberType?: 'parent' | 'student' }
const FEE_RULES: Partial<Record<FeeCode, FeeRule>> = {
  TEACHER_REGISTRATION: { role: 'teacher', purpose: 'teacher_registration', payerType: 'teacher' },
  PARENT_SUBSCRIPTION_MONTHLY: { role: 'parent', purpose: 'subscription', payerType: 'parent', subscriberType: 'parent' },
  PARENT_SUBSCRIPTION_YEARLY: { role: 'parent', purpose: 'subscription', payerType: 'parent', subscriberType: 'parent' },
  STUDENT_SUBSCRIPTION_MONTHLY: { role: 'student', purpose: 'subscription', payerType: 'student', subscriberType: 'student' },
  STUDENT_SUBSCRIPTION_YEARLY: { role: 'student', purpose: 'subscription', payerType: 'student', subscriberType: 'student' },
}

export const isFeeCode = (value: string): value is FeeCode => (FEE_CODES as readonly string[]).includes(value)

export type PurchasePlan =
  | { kind: 'none' } // teacher registration: the period is created at approval (Admin M16)
  | { kind: 'new'; startsAt: Date; endsAt: Date }
  | { kind: 'convert_trial'; startsAt: Date; endsAt: Date; subscriptionId: string }
  | { kind: 'queue'; startsAt: Date; endsAt: Date; subscriptionId: string }

export async function walletConfig(): Promise<{ enabled: boolean; maxRedeemPercent: number }> {
  const [enabled, percent] = await Promise.all([getSettingByKey('features.wallet_enabled'), getSettingByKey('wallet.max_redeem_percent')])
  return { enabled: enabled === true, maxRedeemPercent: Number(percent ?? 50) }
}

export async function walletBalance(userId: string, executor: Executor = db): Promise<number> {
  const row = await executor.selectFrom('wallet_ledger').select((eb) => eb.fn.sum<string>('amount_paise').as('sum')).where('user_id', '=', userId).executeTakeFirst()
  return Number(row?.sum ?? 0)
}

// Subscription purchase rules, BR-43.9. Returns what a successful capture will do, or throws the matching conflict.
async function planSubscriptionPurchase(userId: string, subscriberType: 'parent' | 'student', validityDays: number, now: Date, executor: Executor): Promise<PurchasePlan> {
  const live = await executor
    .selectFrom('subscriptions')
    .select(['id', 'status', 'starts_at', 'ends_at'])
    .where('user_id', '=', userId)
    .where('subscriber_type', '=', subscriberType)
    .where('status', 'in', ['trial', 'active', 'grace', 'free_access'])
    .executeTakeFirst()
  const length = validityDays * DAY_MS

  if (!live) return { kind: 'new', startsAt: now, endsAt: new Date(now.getTime() + length) }
  if (live.status === 'free_access') throw conflictState('Membership is free right now.', { reason: 'free_access' })
  if (live.status === 'trial') return { kind: 'convert_trial', startsAt: now, endsAt: new Date(now.getTime() + length), subscriptionId: live.id }

  const ends = live.ends_at!
  if (ends.getTime() - now.getTime() > QUEUE_WINDOW_DAYS * DAY_MS) {
    throw conflictState('You already have an active plan.', { reason: 'already_subscribed', endsAt: ends.toISOString() })
  }
  return { kind: 'queue', startsAt: ends, endsAt: new Date(ends.getTime() + length), subscriptionId: live.id }
}

// A student whose linked parent holds a live plan is fully covered and never buys (M13 BR-13.4).
export async function parentCoverage(studentUserId: string, executor: Executor = db) {
  const student = await executor
    .selectFrom('students')
    .select(['parent_id', 'parent_link_status'])
    .where('user_id', '=', studentUserId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!student?.parent_id || student.parent_link_status !== 'confirmed') return null

  const parent = await executor.selectFrom('parents').select(['user_id', 'full_name']).where('id', '=', student.parent_id).where('deleted_at', 'is', null).executeTakeFirst()
  if (!parent) return null
  const sub = await executor
    .selectFrom('subscriptions')
    .select(['id', 'fee_code', 'status', 'trial_ends_at', 'ends_at', 'payment_configuration_id'])
    .where('user_id', '=', parent.user_id)
    .where('subscriber_type', '=', 'parent')
    .where('status', 'in', ['trial', 'active', 'grace', 'free_access'])
    .executeTakeFirst()
  if (!sub) return null
  return { parentId: student.parent_id, parentFirstName: parent.full_name.split(' ')[0]!, subscription: sub }
}

export type Quote = {
  config: NonNullable<Awaited<ReturnType<typeof resolveFee>>>
  rule: FeeRule
  feeCode: FeeCode
  amounts: FeeAmounts
  wallet: { balancePaise: number; maxRedeemPercent: number; maxRedeemPaise: number; appliedPaise: number } | null
  plan: PurchasePlan
  context: PaymentContext
}

// Shared by GET /payments/quote and POST /payments/orders: role, preconditions, price version and amounts (BR-43.1 to 43.3).
export async function buildQuote(payer: Payer, input: { feeCode: string; useWallet?: boolean; context?: PaymentContext }, executor: Executor = db, now = new Date()): Promise<Quote> {
  if (!isFeeCode(input.feeCode)) throw validationFailed([{ path: 'feeCode', message: "This item can't be bought here." }], "This item can't be bought here.")
  const feeCode = input.feeCode
  const rule = FEE_RULES[feeCode]
  if (!rule) throw validationFailed([{ path: 'feeCode', message: "This item can't be bought here.", reason: 'not_supported_yet' }], "This item can't be bought here.")

  const context = input.context ?? {}
  if (context.leadId) throw validationFailed([{ path: 'context.leadId', message: 'Not needed for this item.' }], 'Not needed for this item.')
  if (context.renewal && feeCode !== 'TEACHER_REGISTRATION') throw validationFailed([{ path: 'context.renewal', message: 'Not needed for this item.' }], 'Not needed for this item.')

  if (payer.role !== rule.role) throw forbidden("You can't do that.")

  const config = await resolveFee(feeCode, now)
  if (!config) throw conflictState('This item is not available right now.', { reason: 'fee_disabled' })
  if (!config.is_enabled) throw conflictState('This is free right now.', { reason: 'fee_disabled' })

  let plan: PurchasePlan = { kind: 'none' }
  if (rule.purpose === 'teacher_registration') {
    await assertTeacherRegistrationPayable(payer.userId, Boolean(context.renewal), now, executor)
  } else {
    if (rule.subscriberType === 'student') {
      const student = await executor.selectFrom('students').select('parental_consent').where('user_id', '=', payer.userId).where('deleted_at', 'is', null).executeTakeFirst()
      if (!student) throw forbidden("You can't do that.")
      if (student.parental_consent === 'pending' || student.parental_consent === 'declined') {
        throw new ApiError(403, 'FORBIDDEN', 'Ask your parent to approve before subscribing.', { reason: `parental_consent_${student.parental_consent}` })
      }
      if (await parentCoverage(payer.userId, executor)) throw conflictState("You're covered by your parent's membership.", { reason: 'covered_by_parent' })
    }
    plan = await planSubscriptionPurchase(payer.userId, rule.subscriberType!, config.validity_days ?? 30, now, executor)
  }

  const cfg = await walletConfig()
  const balance = cfg.enabled && input.useWallet ? await walletBalance(payer.userId, executor) : 0
  const amounts = computeAmounts({ amountPaise: Number(config.amount_paise), gstInclusive: config.gst_inclusive, gstRateBps: config.gst_rate_bps, walletBalancePaise: balance, maxRedeemPercent: cfg.maxRedeemPercent })

  const shownBalance = cfg.enabled ? await walletBalance(payer.userId, executor) : 0
  const wallet =
    cfg.enabled && shownBalance > 0
      ? { balancePaise: shownBalance, maxRedeemPercent: cfg.maxRedeemPercent, maxRedeemPaise: Math.floor((amounts.listPaise * cfg.maxRedeemPercent) / 100), appliedPaise: amounts.walletPaise }
      : null

  return { config, rule, feeCode, amounts, wallet, plan, context }
}

// First payment: a draft (or re-upload) teacher who has not paid. Renewal: an approved teacher near or past expiry.
async function assertTeacherRegistrationPayable(userId: string, renewal: boolean, now: Date, executor: Executor) {
  const teacher = await executor
    .selectFrom('teachers')
    .select(['id', 'verification_status', 'registration_transaction_id'])
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!teacher) throw forbidden("You can't do that.")

  if (!renewal) {
    if (!['draft', 'reupload_requested'].includes(teacher.verification_status)) throw conflictState('Registration cannot be paid for right now.', { reason: 'not_payable' })
    if (teacher.registration_transaction_id) throw conflictState('Registration fee is already paid.', { reason: 'already_paid' })
    return
  }
  if (teacher.verification_status !== 'approved') throw conflictState('Only an approved teacher can renew.', { reason: 'not_payable' })
  const sub = await executor
    .selectFrom('subscriptions')
    .select('ends_at')
    .where('user_id', '=', userId)
    .where('subscriber_type', '=', 'teacher')
    .where('fee_code', '=', 'TEACHER_REGISTRATION')
    .orderBy('ends_at', 'desc')
    .executeTakeFirst()
  if (sub?.ends_at && sub.ends_at.getTime() - now.getTime() > QUEUE_WINDOW_DAYS * DAY_MS) {
    throw conflictState('You can renew within 30 days of expiry.', { reason: 'already_subscribed', endsAt: sub.ends_at.toISOString() })
  }
}

export const presentQuote = (q: Quote) => ({
  feeCode: q.feeCode,
  paymentConfigurationId: q.config.id,
  version: q.config.version,
  name: q.config.name,
  description: q.config.description,
  billingPeriod: q.config.billing_period,
  validityDays: q.config.validity_days,
  listAmountPaise: q.amounts.listPaise,
  gstRateBps: q.config.gst_rate_bps,
  gstInclusive: q.config.gst_inclusive,
  wallet: q.wallet,
  discountPaise: q.amounts.walletPaise,
  payablePaise: q.amounts.payablePaise,
  basePaise: q.amounts.basePaise,
  gstPaise: q.amounts.gstPaise,
  period: q.plan.kind === 'none' ? null : { startsAt: q.plan.startsAt.toISOString(), endsAt: q.plan.endsAt.toISOString(), queued: q.plan.kind === 'queue' },
})
