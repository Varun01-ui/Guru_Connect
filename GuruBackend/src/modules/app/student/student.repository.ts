import type { Kysely } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'
import type { AppTrx } from '../registration/registration.repository.js'

export function findActiveClass(classId: string) {
  return db.selectFrom('classes').select(['id', 'name', 'level_order']).where('id', '=', classId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

// The "no consent needed" threshold is Class 9 (BR-11.3): classes below its level_order need a parent's OK.
export function findClassNineOrder() {
  return db.selectFrom('classes').select('level_order').where('code', '=', 'CLASS_9').where('deleted_at', 'is', null).executeTakeFirst()
}

export function findActiveBoard(boardId: string) {
  return db.selectFrom('boards').select('id').where('id', '=', boardId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export async function countActiveSubjects(subjectIds: string[]): Promise<number> {
  if (subjectIds.length === 0) return 0
  const row = await db
    .selectFrom('subjects')
    .select(db.fn.countAll<number>().as('n'))
    .where('id', 'in', subjectIds)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

// A live, active parent account whose phone is exactly the one the student typed (BR-11.4 step 4).
export function findActiveParentByPhone(phone: string) {
  return db.selectFrom('parents').select('id').where('phone', '=', phone).where('deleted_at', 'is', null).where('account_status', '=', 'active').executeTakeFirst()
}

export function insertStudentTx(
  trx: AppTrx,
  input: {
    userId: string
    fullName: string
    phone: string
    classId: string
    boardId: string | null
    schoolName: string | null
    cityId: string
    areaId: string | null
    parentName: string | null
    parentPhone: string | null
    parentalConsent: 'pending' | 'not_required'
    parentId: string | null
    referralCodeUsed: string | null
  },
) {
  return trx
    .insertInto('students')
    .values({
      user_id: input.userId,
      full_name: input.fullName,
      phone: input.phone,
      class_id: input.classId,
      board_id: input.boardId,
      school_name: input.schoolName,
      city_id: input.cityId,
      area_id: input.areaId,
      parent_name: input.parentName,
      parent_phone: input.parentPhone,
      parental_consent: input.parentalConsent,
      parent_id: input.parentId,
      parent_link_status: input.parentId ? 'pending' : 'none',
      referral_code_used: input.referralCodeUsed,
    })
    .returning(['id', 'public_code'])
    .executeTakeFirstOrThrow()
}

export function insertStudentConsentsTx(
  trx: AppTrx,
  userId: string,
  input: { termsVersion: string; privacyVersion: string; marketing: boolean; ipAddress: string | null; installId: string | null },
) {
  const base = { user_id: userId, granted: true, method: 'checkbox' as const, ip_address: input.ipAddress, install_id: input.installId }
  // `marketing` is only recorded when the optional box was ticked (BR-11.4 step 3).
  return trx
    .insertInto('user_consents')
    .values([
      { ...base, consent_type: 'terms' as const, document_version: input.termsVersion },
      { ...base, consent_type: 'privacy_policy' as const, document_version: input.privacyVersion },
      ...(input.marketing ? [{ ...base, consent_type: 'marketing' as const, document_version: input.privacyVersion }] : []),
    ])
    .execute()
}

export function findStudentById(studentId: string) {
  return db
    .selectFrom('students')
    .select(['id', 'user_id', 'full_name', 'phone', 'parent_phone', 'parental_consent', 'parental_consent_at'])
    .where('id', '=', studentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

// ---- parental-consent OTP challenges (otp_challenges, purpose = 'parent_consent') ----

export function findLatestConsentChallenge(userId: string) {
  return db
    .selectFrom('otp_challenges')
    .selectAll()
    .where('user_id', '=', userId)
    .where('purpose', '=', 'parent_consent')
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
}

export async function countConsentChallenges(userId: string): Promise<number> {
  const row = await db
    .selectFrom('otp_challenges')
    .select(db.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('purpose', '=', 'parent_consent')
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

// Sending a new code invalidates every earlier unused one (T11.5).
export async function replaceConsentChallenge(
  executor: Kysely<DB>,
  input: { userId: string; destination: string; codeHash: string; ttlSeconds: number; resendCount: number; ipAddress: string | null; installId: string | null },
) {
  await executor
    .updateTable('otp_challenges')
    .set({ consumed_at: new Date() })
    .where('user_id', '=', input.userId)
    .where('purpose', '=', 'parent_consent')
    .where('consumed_at', 'is', null)
    .execute()
  return executor
    .insertInto('otp_challenges')
    .values({
      channel: 'sms',
      destination: input.destination,
      purpose: 'parent_consent',
      code_hash: input.codeHash,
      user_id: input.userId,
      resend_count: input.resendCount,
      ip_address: input.ipAddress,
      install_id: input.installId,
      expires_at: new Date(Date.now() + input.ttlSeconds * 1000),
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
}

export function incrementChallengeAttempts(challengeId: string) {
  return db
    .updateTable('otp_challenges')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', challengeId)
    .returning('attempts')
    .executeTakeFirstOrThrow()
}

export function resetChallengeAttempts(challengeId: string) {
  return db.updateTable('otp_challenges').set({ attempts: 0 }).where('id', '=', challengeId).execute()
}

// Flips pending -> confirmed exactly once (the WHERE guards a double submit) and writes the two consent rows.
export async function confirmConsentTx(trx: AppTrx, input: { studentId: string; userId: string; challengeId: string; guardianPhone: string; documentVersion: string }) {
  const now = new Date()
  const updated = await trx
    .updateTable('students')
    .set({ parental_consent: 'confirmed', parental_consent_at: now })
    .where('id', '=', input.studentId)
    .where('parental_consent', '=', 'pending')
    .returning(['parental_consent_at'])
    .executeTakeFirst()
  if (!updated) return null
  await trx.updateTable('otp_challenges').set({ verified_at: now, consumed_at: now }).where('id', '=', input.challengeId).execute()
  const base = { user_id: input.userId, granted: true, method: 'otp' as const, guardian_phone: input.guardianPhone, document_version: input.documentVersion }
  await trx
    .insertInto('user_consents')
    .values([
      { ...base, consent_type: 'parental_consent' as const },
      { ...base, consent_type: 'data_processing_minor' as const },
    ])
    .execute()
  return updated.parental_consent_at
}
