import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { OAuth2Client } from 'google-auth-library'
import { env, googleOAuthClientIds } from '../../../config/env.js'
import {
  authAccountDisabled,
  authAccountLocked,
  authInvalidCredentials,
  authRefreshInvalid,
  notFound,
  otpExpired,
  otpInvalid,
  otpLocked,
  rateLimited,
  registrationRequired as registrationRequiredError,
  roleMismatch,
  validationFailed,
} from '../../../lib/errors.js'
import { signAppAccessToken, signRegistrationToken } from '../../../lib/appJwt.js'
import { generateOtpCode, hashOtpCode, otpCodeMatches } from '../../../lib/otp.js'
import { hashPassword, verifyPassword } from '../../../lib/password.js'
import { consoleEmailProvider } from '../../../lib/providers/email.js'
import { consoleSmsProvider } from '../../../lib/providers/sms.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { getSettingByKey } from '../bootstrap/bootstrap.repository.js'
import * as repo from './auth.repository.js'
import { issueSession } from './session.js'

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('no-such-app-user', 10)

// Numbers in this range never send a real SMS and always accept 123456 — lets both automated
// tests and manual dev testing exercise the OTP flow without an SMS gateway.
const TEST_PHONE_PREFIX = '+91900000000'
const TEST_PHONE_CODE = '123456'

async function otpConfig() {
  const [ttl, resend, maxPerHour] = await Promise.all([
    getSettingByKey('auth.otp_ttl_seconds'),
    getSettingByKey('auth.otp_resend_after_seconds'),
    getSettingByKey('auth.otp_max_per_hour'),
  ])
  return {
    ttlSeconds: Number(ttl ?? 300),
    resendAfterSeconds: Number(resend ?? 30),
    maxPerHour: Number(maxPerHour ?? 5),
  }
}

export async function requestPhoneOtp(phone: string, ip: string | null, installId: string | null) {
  const cfg = await otpConfig()

  const cooldown = await hitRateLimit(`app-otp-resend:${phone}`, 1, cfg.resendAfterSeconds * 1000)
  if (!cooldown.allowed) throw rateLimited(cooldown.retryAfterSeconds, 'Please wait before requesting another code.')

  const hourly = await hitRateLimit(`app-otp-hour:${phone}`, cfg.maxPerHour, 60 * 60 * 1000)
  if (!hourly.allowed) throw otpLocked('Too many codes requested. Try again in an hour.')

  const isTestNumber = phone.startsWith(TEST_PHONE_PREFIX)
  const code = isTestNumber ? TEST_PHONE_CODE : generateOtpCode()
  const existingUser = await repo.findUserByPhone(phone)

  const challenge = await repo.createOtpChallenge({
    channel: 'sms',
    destination: phone,
    purpose: existingUser ? 'login' : 'signup',
    codeHash: hashOtpCode(code),
    userId: existingUser?.id ?? null,
    ipAddress: ip,
    installId,
    ttlSeconds: cfg.ttlSeconds,
  })

  if (!isTestNumber) await consoleSmsProvider.send(phone, code)

  return { challengeId: challenge.id, expiresInSeconds: cfg.ttlSeconds, resendAfterSeconds: cfg.resendAfterSeconds }
}

export async function requestEmailOtp(email: string, ip: string | null) {
  const cfg = await otpConfig()

  const cooldown = await hitRateLimit(`app-otp-resend:${email}`, 1, cfg.resendAfterSeconds * 1000)
  if (!cooldown.allowed) throw rateLimited(cooldown.retryAfterSeconds, 'Please wait before requesting another code.')

  const hourly = await hitRateLimit(`app-otp-hour:${email}`, cfg.maxPerHour, 60 * 60 * 1000)
  if (!hourly.allowed) throw otpLocked('Too many codes requested. Try again in an hour.')

  const code = generateOtpCode()
  const existingUser = await repo.findUserByEmail(email)

  const challenge = await repo.createOtpChallenge({
    channel: 'email',
    destination: email,
    purpose: existingUser ? 'login' : 'signup',
    codeHash: hashOtpCode(code),
    userId: existingUser?.id ?? null,
    ipAddress: ip,
    installId: null,
    ttlSeconds: cfg.ttlSeconds,
  })

  await consoleEmailProvider.send(email, 'Your GuruConnect sign-in code', `Code: ${code}`)

  return { challengeId: challenge.id, expiresInSeconds: cfg.ttlSeconds, resendAfterSeconds: cfg.resendAfterSeconds }
}

export async function verifyOtp(challengeId: string, code: string, intendedRole: string | undefined, ip: string | null, userAgent: string | null) {
  const challenge = await repo.findActiveChallenge(challengeId)
  if (!challenge) throw otpExpired()
  if (challenge.expires_at < new Date()) throw otpExpired()

  if (!otpCodeMatches(code, challenge.code_hash)) {
    const updated = await repo.incrementAttempts(challengeId)
    if (updated.attempts >= 5) {
      await repo.consumeChallenge(challengeId)
      throw otpLocked()
    }
    throw otpInvalid('Incorrect code.', { attemptsLeft: 5 - updated.attempts })
  }

  await repo.consumeChallenge(challengeId)

  const user = challenge.channel === 'email' ? await repo.findUserByEmail(challenge.destination) : await repo.findUserByPhone(challenge.destination)
  if (!user) {
    const contactType = challenge.channel === 'email' ? 'email' : 'phone'
    const { token } = signRegistrationToken({ sub: challenge.destination, contactType })
    throw registrationRequiredError(token, contactType, env.APP_REGISTRATION_TOKEN_TTL_SECONDS)
  }

  if (intendedRole && intendedRole !== user.user_type) throw roleMismatch(user.user_type, 'This number is registered under a different role.')
  if (user.account_status !== 'active') throw authAccountDisabled('This account is not active.')

  const authMethod = challenge.channel === 'email' ? 'email_otp' : 'otp'
  const session = await issueSession(user.id, user.user_type, { authMethod, ipAddress: ip, userAgent })
  return { ...session, user: { userId: user.id, role: user.user_type, fullName: user.full_name, accountStatus: user.account_status } }
}

export async function refreshSession(refreshToken: string) {
  const hash = repo.hashRefreshToken(refreshToken)
  const session = await repo.findSessionByRefreshToken(refreshToken)

  if (!session) {
    // Not the current token for any session — check whether it's one we already rotated out.
    // If so, this is a replay: kill the whole family, not just this request.
    const reused = await repo.findActiveSessionByPreviousHash(hash)
    if (reused) await repo.revokeTokenFamily(reused.token_family, 'reuse_detected')
    throw authRefreshInvalid('Please sign in again.')
  }

  if (session.revoked_at) throw authRefreshInvalid('Please sign in again.')
  if (session.expires_at < new Date()) {
    await repo.revokeSessionById(session.id, 'expired')
    throw authRefreshInvalid('Please sign in again.')
  }

  const newRefreshToken = randomBytes(32).toString('hex')
  await repo.rotateSession(session.id, hash, newRefreshToken)

  const user = await repo.findUserById(session.user_id)
  if (!user) throw authRefreshInvalid('Please sign in again.')

  const { profileId, instituteId } = await repo.findProfileForUser(user.id, user.user_type)
  const accessToken = signAppAccessToken({ sub: user.id, role: user.user_type, pid: profileId ?? '', ...(instituteId ? { iid: instituteId } : {}), sid: session.id })

  return { accessToken, expiresIn: env.APP_ACCESS_TOKEN_TTL_SECONDS, refreshToken: newRefreshToken }
}

export function logout(sessionId: string) {
  return repo.revokeSessionById(sessionId, 'logout')
}

export function logoutAll(userId: string) {
  return repo.revokeAllSessionsForUser(userId, 'logout_all')
}

export function listSessions(userId: string, currentSessionId: string) {
  return repo.listActiveSessions(userId, currentSessionId)
}

export async function revokeOneSession(userId: string, sessionId: string) {
  const sessions = await repo.listActiveSessions(userId, sessionId)
  if (!sessions.find((s) => s.id === sessionId)) throw notFound('Session not found.')
  await repo.revokeSessionById(sessionId, 'logout')
}

export async function emailPasswordLogin(email: string, password: string, ip: string | null, userAgent: string | null) {
  const identity = await repo.findPasswordIdentity(email)
  if (!identity) {
    await verifyPassword(DUMMY_PASSWORD_HASH, password)
    throw authInvalidCredentials('Incorrect email or password.')
  }
  if (identity.locked_until && identity.locked_until > new Date()) {
    throw authAccountLocked(identity.locked_until.toISOString(), 'Too many attempts. Try again after some time.')
  }
  const ok = await verifyPassword(identity.password_hash ?? DUMMY_PASSWORD_HASH, password)
  if (!ok) {
    await repo.recordFailedPasswordAttempt(identity.id, identity.failed_attempts + 1)
    throw authInvalidCredentials('Incorrect email or password.')
  }
  await repo.resetPasswordAttempts(identity.id)

  const user = await repo.findUserById(identity.user_id)
  if (!user) throw authInvalidCredentials('Incorrect email or password.')

  const session = await issueSession(user.id, user.user_type, { authMethod: 'password', ipAddress: ip, userAgent })
  return { ...session, user: { userId: user.id, role: user.user_type, fullName: user.full_name, accountStatus: user.account_status } }
}

export async function forgotPassword(email: string) {
  const user = await repo.findUserByEmail(email)
  if (user) {
    const cfg = await otpConfig()
    const code = generateOtpCode()
    const challenge = await repo.createOtpChallenge({
      channel: 'email',
      destination: email,
      purpose: 'reset_password',
      codeHash: hashOtpCode(code),
      userId: user.id,
      ipAddress: null,
      installId: null,
      ttlSeconds: cfg.ttlSeconds,
    })
    await consoleEmailProvider.send(email, 'Reset your GuruConnect password', `Code: ${code} (challengeId: ${challenge.id})`)
  }
  return { sent: true }
}

export async function resetPassword(challengeId: string, code: string, newPassword: string) {
  const challenge = await repo.findActiveChallenge(challengeId)
  if (!challenge || challenge.expires_at < new Date()) throw otpExpired()
  if (!otpCodeMatches(code, challenge.code_hash)) {
    const updated = await repo.incrementAttempts(challengeId)
    throw otpInvalid('Incorrect code.', { attemptsLeft: Math.max(0, 5 - updated.attempts) })
  }
  await repo.consumeChallenge(challengeId)
  if (!challenge.user_id) throw notFound('Account not found.')

  const identity = await repo.findPasswordIdentity(challenge.destination)
  const passwordHash = await hashPassword(newPassword)
  if (identity) {
    await repo.updatePassword(identity.id, passwordHash)
  } else {
    await repo.insertPasswordIdentity(challenge.user_id, challenge.destination, passwordHash)
  }
  await repo.revokeAllSessionsForUser(challenge.user_id, 'password_changed')
}

export async function googleSignIn(idToken: string, intendedRole: string | undefined, ip: string | null, userAgent: string | null) {
  if (googleOAuthClientIds.length === 0) throw validationFailed(undefined, 'Google Sign-In is not configured on this server yet.')

  const client = new OAuth2Client()
  const ticket = await client.verifyIdToken({ idToken, audience: googleOAuthClientIds }).catch(() => null)
  const payload = ticket?.getPayload()
  if (!payload?.sub || !payload.email) throw validationFailed(undefined, 'Could not verify this Google account.')
  if (!payload.email_verified) throw validationFailed(undefined, "Verify your Google account's email address first.")

  const existingIdentity = await repo.findGoogleIdentity(payload.sub)
  const user = existingIdentity ? await repo.findUserById(existingIdentity.user_id) : await repo.findUserByEmail(payload.email)

  if (!user) {
    const { token } = signRegistrationToken({ sub: payload.email, contactType: 'google', prefill: { fullName: payload.name, photoUrl: payload.picture } })
    throw registrationRequiredError(token, 'google', env.APP_REGISTRATION_TOKEN_TTL_SECONDS)
  }

  if (!existingIdentity) await repo.linkGoogleIdentity(user.id, payload.sub, payload.email)
  if (intendedRole && intendedRole !== user.user_type) throw roleMismatch(user.user_type, 'This Google account already has a different role.')

  const session = await issueSession(user.id, user.user_type, { authMethod: 'google', ipAddress: ip, userAgent })
  return { ...session, user: { userId: user.id, role: user.user_type, fullName: user.full_name, accountStatus: user.account_status } }
}
