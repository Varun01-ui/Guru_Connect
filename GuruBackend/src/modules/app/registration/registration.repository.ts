import type { Transaction } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'

export type AppTrx = Transaction<DB>

export async function isContactClaimed(phone: string, email: string | undefined): Promise<boolean> {
  const byPhone = await db.selectFrom('app_users').select('id').where('phone', '=', phone).where('deleted_at', 'is', null).executeTakeFirst()
  if (byPhone) return true
  if (email) {
    const byEmail = await db.selectFrom('app_users').select('id').where('email', '=', email).where('deleted_at', 'is', null).executeTakeFirst()
    if (byEmail) return true
  }
  return false
}

export function findCityWithState(cityId: string) {
  return db.selectFrom('cities').select(['id', 'state_id']).where('id', '=', cityId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findAreaInCity(areaId: string, cityId: string) {
  return db.selectFrom('areas').select('id').where('id', '=', areaId).where('city_id', '=', cityId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findActiveReferralCode(code: string) {
  return db.selectFrom('referral_codes').selectAll().where('code', '=', code).where('is_active', '=', true).executeTakeFirst()
}

export async function countReferralUses(referralCodeId: string): Promise<number> {
  const row = await db.selectFrom('referrals').select(db.fn.countAll<number>().as('n')).where('referral_code_id', '=', referralCodeId).executeTakeFirst()
  return Number(row?.n ?? 0)
}

export function findActiveReferralSetting(programCode: string) {
  return db
    .selectFrom('referral_settings')
    .select(['id'])
    .where('program_code', '=', programCode)
    .where('status', '=', 'active')
    .orderBy('effective_from', 'desc')
    .executeTakeFirst()
}

export function insertAppUserTx(trx: AppTrx, input: { fullName: string; phone: string; email: string | null; signupSource: 'organic' | 'referral'; userType?: 'parent' | 'student' | 'teacher' | 'institute_staff'; language?: string }) {
  return trx
    .insertInto('app_users')
    .values({
      user_type: input.userType ?? 'parent',
      ...(input.language ? { preferred_language: input.language } : {}),
      full_name: input.fullName,
      phone: input.phone,
      phone_verified_at: new Date(),
      email: input.email,
      email_verified_at: input.email ? new Date() : null,
      auth_provider: 'otp',
      signup_source: input.signupSource,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
}

export function insertParentTx(
  trx: AppTrx,
  input: { userId: string; fullName: string; email: string | null; phone: string; stateId: string; cityId: string; areaId: string | null; referralCodeUsed: string | null },
) {
  return trx
    .insertInto('parents')
    .values({
      user_id: input.userId,
      full_name: input.fullName,
      email: input.email,
      phone: input.phone,
      state_id: input.stateId,
      city_id: input.cityId,
      area_id: input.areaId,
      referral_code_used: input.referralCodeUsed,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
}

export function insertPhoneIdentityTx(trx: AppTrx, userId: string, phone: string) {
  return trx.insertInto('user_auth_identities').values({ user_id: userId, provider: 'phone', provider_subject: phone }).execute()
}

export function insertReferralTx(trx: AppTrx, input: { referralCodeId: string; referrerUserId: string | null; refereeUserId: string; referralSettingId: string }) {
  return trx
    .insertInto('referrals')
    .values({
      referral_code_id: input.referralCodeId,
      referrer_user_id: input.referrerUserId,
      referee_user_id: input.refereeUserId,
      referral_setting_id: input.referralSettingId,
      status: 'pending',
    })
    .execute()
}

export function insertConsentsTx(
  trx: AppTrx,
  userId: string,
  input: { termsVersion: string; privacyVersion: string; marketingOptIn: boolean; ipAddress: string | null; installId: string | null },
) {
  return trx
    .insertInto('user_consents')
    .values([
      { user_id: userId, consent_type: 'terms', document_version: input.termsVersion, granted: true, method: 'checkbox', ip_address: input.ipAddress, install_id: input.installId },
      { user_id: userId, consent_type: 'privacy_policy', document_version: input.privacyVersion, granted: true, method: 'checkbox', ip_address: input.ipAddress, install_id: input.installId },
      { user_id: userId, consent_type: 'marketing', document_version: input.privacyVersion, granted: input.marketingOptIn, method: 'checkbox', ip_address: input.ipAddress, install_id: input.installId },
    ])
    .execute()
}
