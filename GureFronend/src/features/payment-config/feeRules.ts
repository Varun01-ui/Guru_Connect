import type { BillingPeriod, Fields, Version } from './api/paymentConfig.api'

// What each fee may look like (mirrors the server's rules in M05 section 5). The server stays the authority; this
// keeps the form from offering choices it would refuse.
type Meta = { label: string; periods: BillingPeriod[]; subscription: boolean }

export const FEES: Record<string, Meta> = {
  TEACHER_REGISTRATION: { label: 'Teacher registration', periods: ['yearly', 'one_time'], subscription: false },
  INSTITUTE_REGISTRATION: { label: 'Institute registration', periods: ['yearly', 'one_time'], subscription: false },
  PARENT_SUBSCRIPTION_MONTHLY: { label: 'Parent membership · Monthly', periods: ['monthly'], subscription: true },
  PARENT_SUBSCRIPTION_YEARLY: { label: 'Parent membership · Yearly', periods: ['yearly'], subscription: true },
  STUDENT_SUBSCRIPTION_MONTHLY: { label: 'Student membership · Monthly', periods: ['monthly'], subscription: true },
  STUDENT_SUBSCRIPTION_YEARLY: { label: 'Student membership · Yearly', periods: ['yearly'], subscription: true },
  PREMIUM_TEACHER: { label: 'Premium teacher listing', periods: ['per_30_days'], subscription: false },
  FEATURED_TEACHER: { label: 'Featured teacher listing', periods: ['per_30_days'], subscription: false },
  CONTACT_UNLOCK: { label: 'Contact unlock', periods: ['per_use'], subscription: false },
}

export const feeLabel = (feeCode: string) => FEES[feeCode]?.label ?? feeCode

export const PERIOD_LABELS: Record<BillingPeriod, string> = {
  one_time: 'One time',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  per_30_days: 'Every 30 days',
  per_use: 'Per use',
}
export const PERIOD_SUFFIX: Record<BillingPeriod, string> = { one_time: '', monthly: ' / month', quarterly: ' / quarter', yearly: ' / year', per_30_days: ' / 30 days', per_use: ' / use' }

export const GST_RATES = [0, 500, 1200, 1800, 2800]
export const MAX_AMOUNT_PAISE = 10_000_000

export function fieldProblems(feeCode: string, f: Fields): Record<string, string> {
  const meta = FEES[feeCode]
  const errors: Record<string, string> = {}
  const name = f.name.trim()
  if (name.length < 3 || name.length > 60) errors.name = 'Name must be 3–60 characters.'
  if ((f.description ?? '').trim().length > 200) errors.description = 'Description can be up to 200 characters.'
  if (!Number.isInteger(f.amountPaise) || f.amountPaise < 0 || f.amountPaise > MAX_AMOUNT_PAISE) errors.amountPaise = 'Price must be between ₹0 and ₹1,00,000.'
  if (f.trialDays < 0 || f.trialDays > 90 || !Number.isInteger(f.trialDays)) errors.trialDays = 'Trial must be 0–90 days.'
  else if (meta && !meta.subscription && f.trialDays !== 0) errors.trialDays = 'Only membership plans can have a free trial.'
  if (f.billingPeriod === 'per_use') {
    if (f.validityDays !== null) errors.validityDays = 'Contact unlock has no validity period.'
  } else if (f.validityDays === null) errors.validityDays = 'Enter how many days the purchase lasts.'
  else if (f.validityDays < 1 || f.validityDays > 1095) errors.validityDays = 'Validity must be 1–1,095 days.'
  else if (f.billingPeriod === 'monthly' && (f.validityDays < 28 || f.validityDays > 31)) errors.validityDays = 'Monthly plans last 28–31 days.'
  else if (f.billingPeriod === 'yearly' && f.validityDays !== 365 && f.validityDays !== 366) errors.validityDays = 'Yearly plans last 365 or 366 days.'
  else if (f.billingPeriod === 'per_30_days' && f.validityDays !== 30) errors.validityDays = 'This listing lasts 30 days.'
  return errors
}

export const fieldsOf = (v: Version | Fields): Fields => ({
  name: v.name,
  description: v.description,
  isEnabled: v.isEnabled,
  amountPaise: v.amountPaise,
  gstInclusive: v.gstInclusive,
  gstRateBps: v.gstRateBps,
  billingPeriod: v.billingPeriod,
  validityDays: v.validityDays,
  trialDays: v.trialDays,
})
export function diffFields(now: Fields, was: Fields): Partial<Fields> {
  return Object.fromEntries((Object.keys(now) as (keyof Fields)[]).filter((k) => now[k] !== was[k]).map((k) => [k, now[k]])) as Partial<Fields>
}

// Server rule (M05 section 5): a version may not move the price by more than 50% without a confirmation.
export function priceChangePercent(from: number, to: number): number | null {
  return from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null
}
export const isLargeChange = (from: number, to: number) => {
  const pct = priceChangePercent(from, to)
  return pct !== null && Math.abs(pct) > 50
}
