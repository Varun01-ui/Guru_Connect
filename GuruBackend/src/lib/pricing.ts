import { db } from '../db/index.js'

export const FEE_CODES = [
  'TEACHER_REGISTRATION',
  'INSTITUTE_REGISTRATION',
  'PARENT_SUBSCRIPTION_MONTHLY',
  'PARENT_SUBSCRIPTION_YEARLY',
  'STUDENT_SUBSCRIPTION_MONTHLY',
  'STUDENT_SUBSCRIPTION_YEARLY',
  'PREMIUM_TEACHER',
  'FEATURED_TEACHER',
  'CONTACT_UNLOCK',
] as const
export type FeeCode = (typeof FEE_CODES)[number]

// Admin M05 FR-5.9 resolveFee: the single payment_configurations version in force for a fee at a moment. One
// function for plan cards (M10/M13), quotes/orders (M43) and the registration-fee gate (M15), so they can never disagree.
// The version "in force" is the newest active/scheduled one whose window contains `at`.
export function resolveFee(feeCode: string, at: Date = new Date()) {
  return db
    .selectFrom('payment_configurations')
    .selectAll()
    .where('fee_code', '=', feeCode)
    .where('status', 'in', ['active', 'scheduled'])
    .where('effective_from', '<=', at)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
    .orderBy('effective_from', 'desc')
    .executeTakeFirst()
}
