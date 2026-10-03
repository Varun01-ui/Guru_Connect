import { env } from '../../../config/env.js'
import { db } from '../../../db/index.js'
import { conflictDuplicate, validationFailed } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import type { RegistrationClaims } from '../../../lib/appJwt.js'
import { issueSession } from '../auth/session.js'
import * as repo from './registration.repository.js'
import type { registerParentSchema } from './registration.schemas.js'
import type { z } from 'zod'

const ROLE_TILES = [
  { code: 'parent', title: 'Parent', subtitle: 'Find a teacher for your child' },
  { code: 'student', title: 'Student', subtitle: "Find a teacher for yourself (18+, or with a parent's OK)" },
  { code: 'teacher', title: 'Teacher', subtitle: 'Get discovered by families near you' },
  { code: 'institute', title: 'Institute', subtitle: 'List your coaching centre or school' },
]

const INVITE_TTL_MS = 72 * 3_600_000

// Staff invites waiting for this phone (M21 BR-21.8) and which referral programs are switched on (BR-21.3).
export async function getContext(claims: RegistrationClaims) {
  const invites =
    claims.contactType === 'phone'
      ? await db
          .selectFrom('institute_managers as m')
          .innerJoin('institutes as i', 'i.id', 'm.institute_id')
          .select(['m.id', 'm.staff_role', 'm.invited_at', 'i.name as institute_name'])
          .where('m.phone', '=', claims.sub)
          .where('m.status', '=', 'invited')
          .where('m.user_id', 'is', null)
          .where('i.deleted_at', 'is', null)
          .where('i.account_status', '=', 'active')
          .orderBy('m.invited_at', 'desc')
          .execute()
      : []
  const programs = await db.selectFrom('referral_settings').select(['program_code', 'is_enabled']).where('status', '=', 'active').execute()
  const enabled = (code: string) => Boolean(programs.find((p) => p.program_code === code)?.is_enabled)

  return {
    contactType: claims.contactType,
    verifiedValue: claims.sub,
    prefill: claims.prefill ?? null,
    roles: ROLE_TILES,
    legal: {
      termsVersion: env.LEGAL_TERMS_VERSION,
      termsUrl: 'https://guruconnect.in/terms',
      privacyVersion: env.LEGAL_PRIVACY_VERSION,
      privacyUrl: 'https://guruconnect.in/privacy',
    },
    referralPrograms: { learner: enabled('LEARNER_REFERRAL'), teacher: enabled('TEACHER_REFERRAL'), institute: enabled('INSTITUTE_REFERRAL') },
    invites: invites.map((i) => ({
      inviteId: i.id,
      instituteName: i.institute_name,
      staffRole: i.staff_role,
      invitedAt: i.invited_at?.toISOString() ?? null,
      expired: !i.invited_at || Date.now() - i.invited_at.getTime() > INVITE_TTL_MS,
    })),
  }
}

export async function validateReferral(code: string) {
  const upper = code.toUpperCase()
  if (!/^[A-Za-z0-9]{4,20}$/.test(upper)) return { valid: false as const, reason: 'invalid' as const }

  const row = await repo.findActiveReferralCode(upper)
  if (!row) return { valid: false as const, reason: 'invalid' as const }
  if (row.expires_at && row.expires_at < new Date()) return { valid: false as const, reason: 'expired' as const }
  if (row.usage_limit) {
    const used = await repo.countReferralUses(row.id)
    if (used >= row.usage_limit) return { valid: false as const, reason: 'limit_reached' as const }
  }

  let ownerFirstName: string | undefined
  if (row.user_id) {
    const owner = await db.selectFrom('app_users').select('full_name').where('id', '=', row.user_id).executeTakeFirst()
    ownerFirstName = owner?.full_name.split(' ')[0]
  }
  return { valid: true as const, programCode: row.program_code, ownerFirstName }
}

type RegisterParentBody = z.infer<typeof registerParentSchema>

export async function registerParent(claims: RegistrationClaims, body: RegisterParentBody, idempotencyKey: string, ip: string | null, installId: string | null) {
  const cacheKey = `parent:${claims.jti}:${idempotencyKey}`
  const cached = await getIdempotent(cacheKey)
  if (cached) return cached.body

  if (claims.contactType === 'phone' && claims.sub !== body.mobile) {
    throw validationFailed(undefined, 'Verify your mobile number to continue.')
  }

  if (await repo.isContactClaimed(body.mobile, body.email)) {
    throw conflictDuplicate('An account already exists with this phone number.')
  }

  const city = await repo.findCityWithState(body.cityId)
  if (!city || city.state_id !== body.stateId) throw validationFailed(undefined, 'Choose your city.')

  if (body.areaId) {
    const area = await repo.findAreaInCity(body.areaId, body.cityId)
    if (!area) throw validationFailed(undefined, 'Pick an area in the selected city.')
  }

  let referralApplied = false
  let referralRow: Awaited<ReturnType<typeof repo.findActiveReferralCode>> | undefined
  if (body.referralCode) {
    referralRow = await repo.findActiveReferralCode(body.referralCode)
    if (referralRow && referralRow.program_code === 'LEARNER_REFERRAL') {
      if (!referralRow.expires_at || referralRow.expires_at > new Date()) {
        const used = referralRow.usage_limit ? await repo.countReferralUses(referralRow.id) : 0
        if (!referralRow.usage_limit || used < referralRow.usage_limit) referralApplied = true
      }
    } else {
      referralRow = undefined
    }
  }

  let result: { userId: string; parentId: string }
  try {
    result = await db.transaction().execute(async (trx) => {
      const user = await repo.insertAppUserTx(trx, {
        fullName: body.fullName,
        phone: body.mobile,
        email: body.email ?? null,
        signupSource: referralApplied ? 'referral' : 'organic',
      })
      const parent = await repo.insertParentTx(trx, {
        userId: user.id,
        fullName: body.fullName,
        email: body.email ?? null,
        phone: body.mobile,
        stateId: body.stateId,
        cityId: body.cityId,
        areaId: body.areaId ?? null,
        referralCodeUsed: referralApplied ? body.referralCode! : null,
      })
      await repo.insertPhoneIdentityTx(trx, user.id, body.mobile)

      if (referralApplied && referralRow) {
        const setting = await repo.findActiveReferralSetting('LEARNER_REFERRAL')
        if (setting) {
          await repo.insertReferralTx(trx, { referralCodeId: referralRow.id, referrerUserId: referralRow.user_id, refereeUserId: user.id, referralSettingId: setting.id })
        } else {
          referralApplied = false
        }
      }

      await repo.insertConsentsTx(trx, user.id, {
        termsVersion: env.LEGAL_TERMS_VERSION,
        privacyVersion: env.LEGAL_PRIVACY_VERSION,
        marketingOptIn: body.marketingOptIn,
        ipAddress: ip,
        installId,
      })

      return { userId: user.id, parentId: parent.id }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      throw conflictDuplicate('An account already exists with this phone number.')
    }
    throw err
  }

  const session = await issueSession(result.userId, 'parent', { authMethod: 'otp', ipAddress: ip, userAgent: null })
  const response = {
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    refreshToken: session.refreshToken,
    session: session.session,
    user: {
      userId: result.userId,
      role: 'parent' as const,
      profileId: result.parentId,
      fullName: body.fullName,
      accountStatus: 'active' as const,
      registration: { complete: false, nextStep: 'child_setup' as const },
    },
    referralApplied,
  }
  await putIdempotent(cacheKey, 201, response)
  return response
}

// Shared by student and teacher registration (the parent flow above predates it and keeps its own inline copy).
// Returns the usable referral code row for the program, or undefined when it is unknown, expired, exhausted or
// belongs to another program — a bad code never blocks registration, it just isn't applied.
export async function resolveReferral(code: string | null | undefined, programCode: 'LEARNER_REFERRAL' | 'TEACHER_REFERRAL' | 'INSTITUTE_REFERRAL') {
  if (!code) return undefined
  const row = await repo.findActiveReferralCode(code)
  if (!row || row.program_code !== programCode) return undefined
  if (row.expires_at && row.expires_at < new Date()) return undefined
  if (row.usage_limit && (await repo.countReferralUses(row.id)) >= row.usage_limit) return undefined
  const setting = await repo.findActiveReferralSetting(programCode)
  if (!setting) return undefined
  return { row, settingId: setting.id }
}
