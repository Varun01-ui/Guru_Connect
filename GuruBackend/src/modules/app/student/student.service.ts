import type { z } from 'zod'
import { env } from '../../../config/env.js'
import { db } from '../../../db/index.js'
import type { RegistrationClaims } from '../../../lib/appJwt.js'
import { ApiError, authRequired, conflictState, notFound, otpExpired, otpInvalid, otpLocked, rateLimited, validationFailed } from '../../../lib/errors.js'
import { audit } from '../../../lib/audit.js'
import { kvDel, kvGet, kvSet } from '../../../lib/kv.js'
import { createNotification } from '../../../lib/notify.js'
import { generateOtpCode, hashOtpCode, otpCodeMatches } from '../../../lib/otp.js'
import { maskPhone } from '../../../lib/present.js'
import { consoleSmsProvider } from '../../../lib/providers/sms.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { getSettingByKey } from '../bootstrap/bootstrap.repository.js'
import { issueSession } from '../auth/session.js'
import * as registrationRepo from '../registration/registration.repository.js'
import { resolveReferral } from '../registration/registration.service.js'
import * as repo from './student.repository.js'
import type { registerStudentSchema } from './student.schemas.js'

type RegisterStudentBody = z.infer<typeof registerStudentSchema>

export type RequestContext = { ip: string | null; userAgent: string | null; installId: string | null; requestId: string | null }

const CONSENT_OTP_TTL_SECONDS = 24 * 60 * 60 // BR-11.6: longer than a login OTP, the parent may not look at their phone straight away
const CONSENT_LOCK_SECONDS = 15 * 60
const COLD_START_TTL_SECONDS = 30 * 24 * 60 * 60 // BR-11.5

export const coldStartKey = (userId: string) => `student:coldstart:${userId}`
const usedTokenKey = (jti: string) => `regtoken:used:${jti}`
const lockKey = (studentId: string) => `consent:lock:${studentId}`

const fieldError = (path: string, message: string) => validationFailed([{ path, message }], message)

async function consentOtpSettings() {
  const [resend, maxPerHour] = await Promise.all([getSettingByKey('auth.otp_resend_after_seconds'), getSettingByKey('auth.otp_max_per_hour')])
  return { resendAfterSeconds: Number(resend ?? 30), maxPerHour: Number(maxPerHour ?? 5) }
}

function consentSms(studentName: string, code: string): string {
  return `${studentName} added you as their parent on GuruConnect. Enter ${code} in their app to approve, or ignore to do nothing. Code valid 24 hours.`
}

// POST /registration/student (BR-11.4). The registration token is single-use: a second submit, even with the same
// Idempotency-Key, is AUTH_REQUIRED rather than a replay.
export async function registerStudent(claims: RegistrationClaims, body: RegisterStudentBody, ctx: RequestContext) {
  if (await kvGet(usedTokenKey(claims.jti))) throw authRequired('Please verify your number again.')
  // students.phone is NOT NULL and the form has no phone field, so the verified contact must be the phone.
  if (claims.contactType !== 'phone') throw validationFailed([{ path: 'mobile', message: 'Verify your mobile number to continue.' }], 'Verify your mobile number to continue.')
  const phone = claims.sub

  const cls = await repo.findActiveClass(body.classId)
  if (!cls) throw fieldError('classId', 'Choose your class.')
  const classNine = await repo.findClassNineOrder()
  if (!classNine) throw new Error('Seed data missing: classes.code = CLASS_9')
  const requiresConsent = cls.level_order < classNine.level_order

  const parentName = body.parentName?.trim() || null
  const parentPhone = body.parentPhone ?? null
  if (requiresConsent && !parentName) throw fieldError('parentName', "Enter your parent's name.")
  if (requiresConsent && !parentPhone) throw fieldError('parentPhone', 'Enter a valid phone number.')
  if (parentPhone && parentPhone === phone) throw fieldError('parentPhone', "This can't be your own number.")

  if (body.boardId && !(await repo.findActiveBoard(body.boardId))) throw fieldError('boardId', 'Choose a valid board.')
  const subjectIds = [...new Set(body.subjectIds)]
  if (subjectIds.length !== body.subjectIds.length || (await repo.countActiveSubjects(subjectIds)) !== subjectIds.length) {
    throw fieldError('subjectIds', 'Pick up to 6 subjects.')
  }
  if (!(await registrationRepo.findCityWithState(body.cityId))) throw fieldError('cityId', 'Choose a city.')
  if (body.areaId && !(await registrationRepo.findAreaInCity(body.areaId, body.cityId))) throw fieldError('areaId', 'Pick an area in the selected city.')

  if (await registrationRepo.isContactClaimed(phone, undefined)) throw authRequired('Please verify your number again.')

  const parent = parentPhone ? await repo.findActiveParentByPhone(parentPhone) : undefined
  const referral = await resolveReferral(body.referralCode, 'LEARNER_REFERRAL')
  const consentCode = requiresConsent ? generateOtpCode() : null

  let created: { userId: string; studentId: string; publicCode: string }
  try {
    created = await db.transaction().execute(async (trx) => {
      const user = await registrationRepo.insertAppUserTx(trx, { fullName: body.fullName, phone, email: null, signupSource: referral ? 'referral' : 'organic', userType: 'student' })
      const student = await repo.insertStudentTx(trx, {
        userId: user.id,
        fullName: body.fullName,
        phone,
        classId: cls.id,
        boardId: body.boardId ?? null,
        schoolName: body.schoolName?.trim() || null,
        cityId: body.cityId,
        areaId: body.areaId ?? null,
        parentName,
        parentPhone,
        parentalConsent: requiresConsent ? 'pending' : 'not_required',
        parentId: parent?.id ?? null,
        referralCodeUsed: referral ? body.referralCode! : null,
      })
      await registrationRepo.insertPhoneIdentityTx(trx, user.id, phone)
      await repo.insertStudentConsentsTx(trx, user.id, {
        termsVersion: env.LEGAL_TERMS_VERSION,
        privacyVersion: env.LEGAL_PRIVACY_VERSION,
        marketing: body.consents.marketing,
        ipAddress: ctx.ip,
        installId: ctx.installId,
      })
      if (referral) {
        await registrationRepo.insertReferralTx(trx, { referralCodeId: referral.row.id, referrerUserId: referral.row.user_id, refereeUserId: user.id, referralSettingId: referral.settingId })
      }
      if (consentCode && parentPhone) {
        await repo.replaceConsentChallenge(trx, {
          userId: user.id,
          destination: parentPhone,
          codeHash: hashOtpCode(consentCode),
          ttlSeconds: CONSENT_OTP_TTL_SECONDS,
          resendCount: 0,
          ipAddress: ctx.ip,
          installId: ctx.installId,
        })
      }
      await audit(trx, {
        actorType: 'app_user',
        actorId: user.id,
        action: 'app.student_registered',
        module: 'app.student_registration',
        entityType: 'student',
        entityId: student.id,
        newValues: { classId: cls.id, boardId: body.boardId ?? null, cityId: body.cityId, consentRequired: requiresConsent },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      })
      return { userId: user.id, studentId: student.id, publicCode: student.public_code }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') throw authRequired('Please verify your number again.')
    throw err
  }

  await kvSet(usedTokenKey(claims.jti), '1', env.APP_REGISTRATION_TOKEN_TTL_SECONDS + 60)
  if (subjectIds.length > 0) await kvSet(coldStartKey(created.userId), JSON.stringify(subjectIds), COLD_START_TTL_SECONDS)

  if (consentCode && parentPhone) {
    // The first code counts toward the hourly cap but not the resend cooldown (the student has not asked for a resend yet).
    await hitRateLimit(`consent-otp-hour:${created.studentId}`, (await consentOtpSettings()).maxPerHour, 60 * 60 * 1000)
    try {
      await consoleSmsProvider.sendMessage(parentPhone, consentSms(body.fullName, consentCode))
    } catch {
      // The account exists and the student can use Resend; a gateway hiccup must not undo the registration.
    }
  }

  const session = await issueSession(created.userId, 'student', { authMethod: 'otp', ipAddress: ctx.ip, userAgent: ctx.userAgent })
  return {
    userId: created.userId,
    role: 'student' as const,
    studentId: created.studentId,
    publicCode: created.publicCode,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    parentalConsent: requiresConsent ? ('pending' as const) : ('not_required' as const),
    parentPhoneMasked: requiresConsent ? maskPhone(parentPhone) : null,
    nextStep: requiresConsent ? ('parent_consent' as const) : null,
  }
}

// POST /student/parent-consent/request (BR-11.7): resend the code to the parent's phone.
export async function requestParentConsent(studentId: string, ctx: RequestContext) {
  const student = await repo.findStudentById(studentId)
  if (!student) throw notFound('Profile not found.')
  if (student.parental_consent !== 'pending' || !student.parent_phone) {
    throw conflictState('Parent approval is not needed right now.', { reason: `parental_consent_${student.parental_consent}` })
  }

  const cfg = await consentOtpSettings()
  const cooldown = await hitRateLimit(`consent-otp-resend:${studentId}`, 1, cfg.resendAfterSeconds * 1000)
  if (!cooldown.allowed) throw rateLimited(cooldown.retryAfterSeconds, 'Please wait before requesting another code.')
  const hourly = await hitRateLimit(`consent-otp-hour:${studentId}`, cfg.maxPerHour, 60 * 60 * 1000)
  if (!hourly.allowed) throw otpLocked('Too many codes requested. Try again in an hour.')

  const code = generateOtpCode()
  const resendCount = await repo.countConsentChallenges(student.user_id)
  await db.transaction().execute(async (trx) => {
    await repo.replaceConsentChallenge(trx, {
      userId: student.user_id,
      destination: student.parent_phone!,
      codeHash: hashOtpCode(code),
      ttlSeconds: CONSENT_OTP_TTL_SECONDS,
      resendCount,
      ipAddress: ctx.ip,
      installId: ctx.installId,
    })
    await audit(trx, {
      actorType: 'app_user',
      actorId: student.user_id,
      action: 'app.parental_consent_requested',
      module: 'app.student_registration',
      entityType: 'student',
      entityId: studentId,
      newValues: { resendCount },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
  })
  // A new code unlocks a previous lockout: it is a different challenge with a fresh attempt counter.
  await kvDel(lockKey(studentId))

  try {
    await consoleSmsProvider.sendMessage(student.parent_phone, consentSms(student.full_name, code))
  } catch {
    throw new ApiError(502, 'GATEWAY_ERROR', "We couldn't send the SMS. Try again.")
  }
  return { resendAfterSeconds: cfg.resendAfterSeconds, parentPhoneMasked: maskPhone(student.parent_phone) }
}

// POST /student/parent-consent/verify (BR-11.7).
export async function verifyParentConsent(studentId: string, code: string, ctx: RequestContext) {
  const student = await repo.findStudentById(studentId)
  if (!student) throw notFound('Profile not found.')
  if (student.parental_consent !== 'pending') {
    throw conflictState('Parent approval is not needed right now.', { reason: `parental_consent_${student.parental_consent}` })
  }

  const lockedUntil = Number((await kvGet(lockKey(studentId))) ?? 0)
  if (lockedUntil > Date.now()) {
    throw new ApiError(429, 'OTP_LOCKED', 'Too many attempts. Try again in 15 minutes.', { retryAfterSeconds: Math.ceil((lockedUntil - Date.now()) / 1000) })
  }

  const challenge = await repo.findLatestConsentChallenge(student.user_id)
  if (!challenge || challenge.expires_at < new Date()) throw otpExpired('That code expired.')
  // The 15-minute lock has passed: the same code gets a fresh set of attempts (T11.4).
  if (challenge.attempts >= 5) await repo.resetChallengeAttempts(challenge.id)

  if (!otpCodeMatches(code, challenge.code_hash)) {
    const { attempts } = await repo.incrementChallengeAttempts(challenge.id)
    const left = 5 - attempts
    if (left <= 0) {
      await kvSet(lockKey(studentId), String(Date.now() + CONSENT_LOCK_SECONDS * 1000), CONSENT_LOCK_SECONDS)
      throw new ApiError(429, 'OTP_LOCKED', 'Too many attempts. Try again in 15 minutes.', { retryAfterSeconds: CONSENT_LOCK_SECONDS })
    }
    throw otpInvalid(`That code isn't right. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`, { attemptsLeft: left })
  }

  const confirmedAt = await db.transaction().execute(async (trx) => {
    const at = await repo.confirmConsentTx(trx, {
      studentId,
      userId: student.user_id,
      challengeId: challenge.id,
      guardianPhone: student.parent_phone ?? challenge.destination,
      documentVersion: env.LEGAL_PRIVACY_VERSION,
    })
    if (!at) return null
    await audit(trx, {
      actorType: 'app_user',
      actorId: student.user_id,
      action: 'app.parental_consent_confirmed',
      module: 'app.student_registration',
      entityType: 'student',
      entityId: studentId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    await createNotification(trx, {
      userId: student.user_id,
      category: 'account',
      eventType: 'student.parental_consent_confirmed',
      title: 'Your parent approved!',
      body: 'You can now contact teachers and book demos.',
      deepLink: 'gc://home',
    })
    return at
  })
  if (!confirmedAt) throw conflictState('Parent approval is not needed right now.', { reason: 'parental_consent_confirmed' })
  return { parentalConsent: 'confirmed' as const, parentalConsentAt: confirmedAt.toISOString() }
}

// HOOK for Modules 37/38 (contact teacher, book demo — out of scope here): call before creating a lead or demo.
// Checked on every attempt against the database, never a cached client flag (M11 section 17).
export async function assertParentalConsentAllows(studentId: string): Promise<void> {
  const student = await repo.findStudentById(studentId)
  if (!student) throw notFound('Profile not found.')
  if (student.parental_consent === 'pending') {
    throw new ApiError(403, 'FORBIDDEN', 'Ask your parent to approve before contacting a teacher.', { reason: 'parental_consent_pending' })
  }
  if (student.parental_consent === 'declined') {
    throw new ApiError(403, 'FORBIDDEN', 'Your account is on hold. Contact support for help.', { reason: 'parental_consent_declined' })
  }
}
