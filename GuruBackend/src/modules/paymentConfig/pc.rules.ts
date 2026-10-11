import { FEE_CODES } from '../../lib/pricing.js'
import type { FeeCode } from '../../lib/pricing.js'

export { FEE_CODES }
export type { FeeCode }

export type BillingPeriod = 'one_time' | 'monthly' | 'quarterly' | 'yearly' | 'per_30_days' | 'per_use'

// M05 section 5: what each fee may look like. The billing period and validity are fixed by the kind of fee, so an
// admin can't, for example, sell a "yearly" plan that lasts 30 days.
type FeeRule = { periods: BillingPeriod[]; periodMessage: string; subscription: boolean; defaultPeriod: BillingPeriod }

export const FEE_RULES: Record<FeeCode, FeeRule> = {
  TEACHER_REGISTRATION: { periods: ['yearly', 'one_time'], periodMessage: 'Registration fees must use a yearly or one-time period.', subscription: false, defaultPeriod: 'yearly' },
  INSTITUTE_REGISTRATION: { periods: ['yearly', 'one_time'], periodMessage: 'Registration fees must use a yearly or one-time period.', subscription: false, defaultPeriod: 'yearly' },
  PARENT_SUBSCRIPTION_MONTHLY: { periods: ['monthly'], periodMessage: 'Monthly plans must use a monthly period.', subscription: true, defaultPeriod: 'monthly' },
  PARENT_SUBSCRIPTION_YEARLY: { periods: ['yearly'], periodMessage: 'Yearly plans must use a yearly period.', subscription: true, defaultPeriod: 'yearly' },
  STUDENT_SUBSCRIPTION_MONTHLY: { periods: ['monthly'], periodMessage: 'Monthly plans must use a monthly period.', subscription: true, defaultPeriod: 'monthly' },
  STUDENT_SUBSCRIPTION_YEARLY: { periods: ['yearly'], periodMessage: 'Yearly plans must use a yearly period.', subscription: true, defaultPeriod: 'yearly' },
  PREMIUM_TEACHER: { periods: ['per_30_days'], periodMessage: 'Listings are charged every 30 days.', subscription: false, defaultPeriod: 'per_30_days' },
  FEATURED_TEACHER: { periods: ['per_30_days'], periodMessage: 'Listings are charged every 30 days.', subscription: false, defaultPeriod: 'per_30_days' },
  CONTACT_UNLOCK: { periods: ['per_use'], periodMessage: 'Contact unlock is charged per use.', subscription: false, defaultPeriod: 'per_use' },
}

export const isFeeCode = (value: string): value is FeeCode => (FEE_CODES as readonly string[]).includes(value)

export const GST_RATES_BPS = [0, 500, 1200, 1800, 2800] as const
export const MAX_AMOUNT_PAISE = 10_000_000 // ₹1,00,000
export const LARGE_CHANGE_PERCENT = 50

// The editable part of a version.
export type VersionFields = {
  name: string
  description: string | null
  isEnabled: boolean
  amountPaise: number
  gstInclusive: boolean
  gstRateBps: number
  billingPeriod: BillingPeriod
  validityDays: number | null
  trialDays: number
}

export type Issue = { path: string; message: string }

// Cross-field rules. `forPublish` adds the rules that only matter once the version is going live (a draft may
// still be a work in progress, e.g. a price of 0 while the admin is typing).
export function versionIssues(feeCode: FeeCode, v: VersionFields, forPublish: boolean): Issue[] {
  const rule = FEE_RULES[feeCode]
  const issues: Issue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })

  if (!rule.periods.includes(v.billingPeriod)) add('billingPeriod', rule.periodMessage)

  if (v.billingPeriod === 'per_use') {
    if (v.validityDays !== null) add('validityDays', 'Contact unlock has no validity period.')
  } else if (v.validityDays === null) {
    add('validityDays', 'Enter how many days the purchase lasts.')
  } else if (v.validityDays < 1 || v.validityDays > 1095) {
    add('validityDays', 'Validity must be 1–1,095 days.')
  } else if (v.billingPeriod === 'monthly' && (v.validityDays < 28 || v.validityDays > 31)) {
    add('validityDays', 'Monthly plans last 28–31 days.')
  } else if (v.billingPeriod === 'yearly' && v.validityDays !== 365 && v.validityDays !== 366) {
    add('validityDays', 'Yearly plans last 365 or 366 days.')
  } else if (v.billingPeriod === 'per_30_days' && v.validityDays !== 30) {
    add('validityDays', 'This listing lasts 30 days.')
  }

  if (!rule.subscription && v.trialDays !== 0) add('trialDays', 'Only membership plans can have a free trial.')

  if (forPublish && v.isEnabled && v.amountPaise === 0 && !(rule.subscription && v.trialDays > 0)) {
    add('amountPaise', 'A paid fee needs a price above ₹0. Switch it off to make it free.')
  }
  return issues
}

// ---- display helpers (preview card, impact) ----

export const formatRupees = (paise: number): string => {
  const rupees = paise / 100
  const whole = Number.isInteger(rupees)
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`
}

const roundedRupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`

const PERIOD_LABEL: Record<BillingPeriod, string> = {
  one_time: 'one time',
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
  per_30_days: '30 days',
  per_use: 'use',
}

export function priceCard(v: VersionFields) {
  const label = PERIOD_LABEL[v.billingPeriod]
  const base = v.gstInclusive ? Math.floor((2 * v.amountPaise * 10_000 + (10_000 + v.gstRateBps)) / (2 * (10_000 + v.gstRateBps))) : v.amountPaise
  const gst = v.gstInclusive ? v.amountPaise - base : Math.floor((2 * v.amountPaise * v.gstRateBps + 10_000) / 20_000)
  return {
    title: v.name,
    priceText: v.billingPeriod === 'one_time' ? formatRupees(v.amountPaise) : `${formatRupees(v.amountPaise)} / ${label}`,
    perMonthText: v.billingPeriod === 'yearly' ? `${roundedRupees(v.amountPaise / 12)} / month` : null,
    gstText: v.gstRateBps === 0 ? null : v.gstInclusive ? `incl. ${roundedRupees(gst)} GST` : `+ ${roundedRupees(gst)} GST`,
    trialText: v.trialDays > 0 ? `${v.trialDays}-day free trial` : null,
    enabled: v.isEnabled,
  }
}
