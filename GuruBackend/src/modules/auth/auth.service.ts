import { createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { env } from '../../config/env.js'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import {
  authAccountDisabled,
  authAccountLocked,
  authInvalidCredentials,
  authLinkExpired,
  authRefreshInvalid,
  forbidden,
  notFound,
  otpExpired,
  otpInvalid,
  rateLimited,
  validationFailed,
} from '../../lib/errors.js'
import { signAccessToken } from '../../lib/jwt.js'
import { generateOtpCode, toIndianE164 } from '../../lib/otp.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { passwordPolicyIssues } from '../../lib/passwordPolicy.js'
import { getEffectivePermissions } from '../../lib/permissions.js'
import { hitRateLimit } from '../../lib/rateLimit.js'
import { denySessions } from '../../lib/sessionDenylist.js'
import { generateOpaqueToken, sha256Hex } from '../../lib/tokens.js'
import {
  sendAccountLockedEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendTokenReuseEmail,
} from './auth.emails.js'
import * as repo from './auth.repository.js'

type Admin = Awaited<ReturnType<typeof repo.findAdminByEmail>>

const DUMMY_HASH = bcrypt.hashSync('no-such-admin', 12)

const MAX_ACTIVE_SESSIONS = 10
const REFRESH_GRACE_MS = 10_000
const LOGIN_PER_EMAIL = { max: 5, windowMs: 60_000 }
const LOGIN_PER_IP = { max: 20, windowMs: 60 * 60_000 }
const FORGOT_PER_EMAIL = { max: 3, windowMs: 60 * 60_000 }

export type LoginResult = {
  accessToken: string
  expiresIn: number
  // null when a parallel refresh was served inside the grace window: the browser already holds the
  // rotated cookie from the winning request, so nothing must be (re)set.
  refreshToken: string | null
  csrfToken: string | null
  sessionExpiresAt: Date
  admin: { id: string; email: string; fullName: string; isSuperAdmin: boolean; avatarUrl: null }
}

export type RequestContext = { ip: string | null; userAgent: string | null; origin?: string | null }

function publicAdmin(admin: NonNullable<Admin>) {
  return { id: admin.id, email: admin.email, fullName: admin.full_name, isSuperAdmin: admin.is_super_admin, avatarUrl: null }
}

function parseDeviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : 'a device'
  return `${browser} on ${os}`
}

async function createLoginSession(admin: NonNullable<Admin>, rememberMe: boolean, ctx: RequestContext): Promise<LoginResult> {
  const refreshToken = generateOpaqueToken()
  const refreshTokenHash = sha256Hex(refreshToken)
  const days = rememberMe ? env.REFRESH_TOKEN_TTL_DAYS_REMEMBER : env.REFRESH_TOKEN_TTL_DAYS
  const expiresAt = new Date(Date.now() + days * 86_400_000)

  const session = await repo.createSession({
    adminId: admin.id,
    refreshTokenHash,
    ipAddress: ctx.ip,
    userAgent: ctx.userAgent,
    deviceLabel: parseDeviceLabel(ctx.userAgent),
    expiresAt,
  })

  // Sign-in on an 11th device quietly signs out the least recently used one.
  await denySessions(await repo.revokeSessionsOverCap(admin.id, MAX_ACTIVE_SESSIONS))

  return {
    accessToken: accessTokenFor(admin, session.id),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    csrfToken: generateOpaqueToken(),
    sessionExpiresAt: expiresAt,
    admin: publicAdmin(admin),
  }
}

function accessTokenFor(admin: NonNullable<Admin>, sessionId: string) {
  return signAccessToken({
    sub: admin.id,
    sid: sessionId,
    sa: admin.is_super_admin,
    pwd: Math.floor(new Date(admin.password_changed_at).getTime() / 1000),
  })
}

async function enforceLoginRateLimit(email: string, ip: string | null) {
  const perEmail = await hitRateLimit(`login:${ip}:${email}`, LOGIN_PER_EMAIL.max, LOGIN_PER_EMAIL.windowMs)
  const perIp = await hitRateLimit(`login-ip:${ip}`, LOGIN_PER_IP.max, LOGIN_PER_IP.windowMs)
  if (!perEmail.allowed || !perIp.allowed) {
    throw rateLimited(Math.max(perEmail.retryAfterSeconds, perIp.retryAfterSeconds), 'Too many attempts. Wait a minute and try again.')
  }
}

export async function login(email: string, password: string, rememberMe: boolean, ctx: RequestContext): Promise<LoginResult> {
  await enforceLoginRateLimit(email, ctx.ip)
  const admin = await repo.findAdminByEmail(email)

  if (!admin) {
    await verifyPassword(DUMMY_HASH, password)
    await audit(db, {
      actorType: 'system',
      action: 'auth.login_failed',
      module: 'auth',
      reason: 'unknown_email',
      ip: ctx.ip,
      newValues: { emailHash: sha256Hex(email) },
    })
    throw authInvalidCredentials()
  }

  if (admin.status === 'disabled') {
    await audit(db, { actorType: 'system', action: 'auth.login_failed', module: 'auth', actorId: admin.id, reason: 'disabled', ip: ctx.ip })
    throw authAccountDisabled()
  }

  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    const until = new Date(admin.locked_until)
    throw authAccountLocked(until.toISOString(), `Too many attempts. Try again after ${until.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`)
  }

  const ok = await verifyPassword(admin.password_hash, password)
  if (!ok) {
    const nextCount = admin.failed_login_count + 1
    const lockUntil = nextCount >= 5 ? new Date(Date.now() + 15 * 60_000) : null
    await repo.incrementFailedLogin(admin.id, lockUntil)
    await audit(db, { actorType: 'system', action: 'auth.login_failed', module: 'auth', actorId: admin.id, actorEmail: admin.email, reason: 'bad_password', ip: ctx.ip })
    if (lockUntil) {
      await audit(db, { actorType: 'system', action: 'auth.account_locked', module: 'auth', actorId: admin.id, actorEmail: admin.email, newValues: { lockedUntil: lockUntil } })
      await sendAccountLockedEmail(admin.email, lockUntil)
    }
    throw authInvalidCredentials()
  }

  await repo.markLoginSuccess(admin.id, ctx.ip)
  const session = await createLoginSession(admin, rememberMe, ctx)
  await audit(db, { actorType: 'admin', actorId: admin.id, actorEmail: admin.email, action: 'auth.login_succeeded', module: 'auth', ip: ctx.ip, newValues: { rememberMe, method: 'password', device: parseDeviceLabel(ctx.userAgent) } })
  return session
}

export async function refresh(refreshToken: string | undefined, csrfHeader: string | undefined, csrfCookie: string | undefined, ctx: RequestContext): Promise<LoginResult> {
  if (!refreshToken) throw authRefreshInvalid()
  // Double-submit CSRF token plus an Origin check (browsers always send Origin on cross-site POSTs).
  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) throw forbidden('Session check failed. Reload the page.')
  if (ctx.origin && ctx.origin !== env.CORS_ORIGIN) throw forbidden('Session check failed. Reload the page.')

  const hash = sha256Hex(refreshToken)
  const session = await repo.findSessionByRefreshHash(hash)

  if (!session) return handleRotatedToken(hash)

  if (session.revoked_at) throw authRefreshInvalid()
  if (new Date(session.expires_at) < new Date()) {
    await denySessions(await repo.revokeSession(session.id, 'expired'))
    throw authRefreshInvalid()
  }

  const admin = await repo.findAdminById(session.admin_id)
  if (!admin || admin.status === 'disabled') {
    await denySessions(await repo.revokeSession(session.id, 'account_disabled'))
    throw authRefreshInvalid()
  }

  const newRefreshToken = generateOpaqueToken()
  const rotated = await repo.rotateSession(session.id, { newHash: sha256Hex(newRefreshToken), previousHash: hash })
  // Lost a race with a parallel refresh of the same token: that request won, treat this one as the grace case.
  if (!rotated) return handleRotatedToken(hash)

  return {
    accessToken: accessTokenFor(admin, session.id),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: newRefreshToken,
    csrfToken: generateOpaqueToken(),
    sessionExpiresAt: session.expires_at as unknown as Date,
    admin: publicAdmin(admin),
  }
}

// The presented token no longer matches any session's current hash. Either it was rotated a moment ago by a
// parallel tab (fine, inside the grace window) or an old token is being replayed (revoke the whole family).
async function handleRotatedToken(hash: string): Promise<LoginResult> {
  const previous = await repo.findActiveSessionByPreviousHash(hash)
  if (!previous) throw authRefreshInvalid()

  const admin = await repo.findAdminById(previous.admin_id)
  const withinGrace = Date.now() - new Date(previous.last_used_at).getTime() < REFRESH_GRACE_MS
  if (withinGrace && admin && admin.status !== 'disabled') {
    return {
      accessToken: accessTokenFor(admin, previous.id),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: null,
      csrfToken: null,
      sessionExpiresAt: previous.expires_at as unknown as Date,
      admin: publicAdmin(admin),
    }
  }

  const revokedIds = await repo.revokeSessionFamily(previous.token_family, 'token_reuse')
  await denySessions(revokedIds)
  await audit(db, {
    actorType: 'system',
    action: 'auth.token_reuse_detected',
    module: 'auth',
    actorId: previous.admin_id,
    entityType: 'admin_session',
    entityId: previous.id,
    newValues: { tokenFamily: previous.token_family, sessionsRevoked: revokedIds.length },
  })
  if (admin) await sendTokenReuseEmail(admin.email)
  throw authRefreshInvalid('For your security we signed you out everywhere. Sign in again.')
}

export async function logout(admin: { id: string; email: string }, sessionId: string) {
  const revoked = await repo.revokeSession(sessionId, 'logout')
  await denySessions(revoked)
  await audit(db, { actorType: 'admin', actorId: admin.id, actorEmail: admin.email, action: 'auth.logout', module: 'auth', newValues: { sessionIds: revoked } })
}

export async function logoutAll(admin: { id: string; email: string }) {
  const revoked = await repo.revokeAllSessionsForAdmin(admin.id, 'logout_all')
  await denySessions(revoked)
  await audit(db, { actorType: 'admin', actorId: admin.id, actorEmail: admin.email, action: 'auth.logout_all', module: 'auth', newValues: { sessionIds: revoked } })
}

export async function forgotPassword(email: string, ip: string | null) {
  // Counted per email whether or not the account exists, so the limit itself reveals nothing.
  const limit = await hitRateLimit(`forgot:${email}`, FORGOT_PER_EMAIL.max, FORGOT_PER_EMAIL.windowMs)
  if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds, 'Too many reset requests. Try again later.')

  const admin = await repo.findAdminByEmail(email)
  if (admin && admin.status !== 'disabled') {
    await repo.invalidateUnusedResetTokens(admin.id)
    const token = generateOpaqueToken()
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    await repo.createPasswordResetToken({ adminId: admin.id, tokenHash: sha256Hex(token), purpose: 'reset', expiresAt, requestedIp: ip })
    await audit(db, { actorType: 'system', action: 'auth.password_reset_requested', module: 'auth', actorId: admin.id, ip })
    await sendPasswordResetEmail(admin.email, token)
  }
}

export async function validateResetToken(token: string) {
  const row = await repo.findValidResetToken(sha256Hex(token))
  if (!row) throw authLinkExpired()
  return { purpose: row.purpose }
}

export async function resetPassword(token: string, newPassword: string) {
  const row = await repo.findValidResetToken(sha256Hex(token))
  if (!row) throw authLinkExpired()

  const admin = await repo.findAdminById(row.admin_id)
  if (!admin || admin.status === 'disabled') throw authLinkExpired()

  const issues = passwordPolicyIssues(newPassword, { email: admin.email, fullName: admin.full_name })
  if (issues.length > 0) throw validationFailed(issues.map((message) => ({ path: 'newPassword', message })))

  const sameAsCurrent = await verifyPassword(admin.password_hash, newPassword)
  if (sameAsCurrent) throw validationFailed([{ path: 'newPassword', message: "Choose a password you haven't used before." }])

  if (!(await repo.markResetTokenUsed(row.id))) throw authLinkExpired()
  await repo.updateAdminPassword(admin.id, await hashPassword(newPassword))
  const revoked = await repo.revokeAllSessionsForAdmin(admin.id, 'password_changed')
  await denySessions(revoked)
  await audit(db, {
    actorType: 'admin',
    actorId: admin.id,
    actorEmail: admin.email,
    action: row.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
    module: 'auth',
    newValues: { sessionsRevoked: revoked.length },
  })
  await sendPasswordChangedEmail(admin.email)
}

export async function me(adminId: string) {
  const admin = await repo.findAdminById(adminId)
  if (!admin) throw notFound('Admin not found')
  const profile = await repo.getAdminProfile(admin.id)
  const roles = await db
    .selectFrom('admin_roles as ar')
    .innerJoin('roles as r', 'r.id', 'ar.role_id')
    .select(['r.code', 'r.name'])
    .where('ar.admin_id', '=', admin.id)
    .where('r.deleted_at', 'is', null)
    .orderBy('r.name')
    .execute()
  const permissions = await getEffectivePermissions(admin.id, admin.is_super_admin)
  // Changes whenever the admin's roles or permissions do, so open tabs can poll `/auth/me?etag=` cheaply (FR-2.4).
  const etag = createHash('sha256').update(JSON.stringify([admin.is_super_admin, roles.map((r) => r.code), permissions])).digest('hex').slice(0, 16)

  return {
    id: admin.id,
    email: admin.email,
    fullName: admin.full_name,
    isSuperAdmin: admin.is_super_admin,
    roles,
    permissions,
    etag,
    profile: {
      displayName: profile?.display_name ?? admin.full_name,
      timezone: profile?.timezone ?? 'Asia/Kolkata',
      theme: profile?.theme ?? 'system',
      avatarUrl: null,
    },
  }
}

export async function sessions(adminId: string) {
  const rows = await repo.listSessions(adminId)
  return rows.map((s) => ({
    id: s.id,
    deviceLabel: s.device_label,
    ipAddress: s.ip_address,
    lastUsedAt: s.last_used_at,
    createdAt: s.created_at,
  }))
}

export async function revokeOwnSession(admin: { id: string; email: string }, sessionId: string) {
  const row = await repo.findOwnSession(admin.id, sessionId)
  if (!row) throw notFound('Session not found.')
  const revoked = await repo.revokeSession(sessionId, 'logout')
  await denySessions(revoked)
  await audit(db, { actorType: 'admin', actorId: admin.id, actorEmail: admin.email, action: 'auth.session_revoked', module: 'auth', entityType: 'admin_session', entityId: sessionId })
}

// DELETE /admins/:adminId/sessions. Spec permission is `sessions.revoke_any`; until M02 (RBAC) exists that is
// approximated by "super admin" (who bypasses every permission check anyway). Swap for requirePermission in M02.
export async function revokeAllSessionsOfAdmin(actor: { id: string; email: string }, targetAdminId: string) {
  const target = await repo.findAdminById(targetAdminId)
  if (!target) throw notFound('Admin not found')
  const revoked = await repo.revokeAllSessionsForAdmin(target.id, 'admin_forced')
  await denySessions(revoked)
  await audit(db, {
    actorType: 'admin',
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'auth.session_revoked',
    module: 'auth',
    entityType: 'admin',
    entityId: target.id,
    newValues: { sessionIds: revoked, targetAdminId: target.id },
  })
}

export async function requestOtp(phone: string, ip: string | null) {
  const limit = await hitRateLimit(`admin-otp:${phone}`, 5, 60 * 60_000)
  if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds, 'Too many codes requested. Try again later.')

  // Dev/demo behaviour: any 10-digit number gets a working code. If it doesn't match a
  // registered admin's phone, it falls back to the super admin so OTP login works for testing
  // without registering every number in admin_profiles first.
  const admin = (await repo.findAdminByPhone(toIndianE164(phone))) ?? (await repo.findFallbackAdminForOtp())
  if (!admin || admin.status === 'disabled') {
    return { sent: true, devCode: null as string | null, expiresInSeconds: env.OTP_TTL_MINUTES * 60 }
  }

  await repo.expirePendingOtps(admin.id, phone)
  const code = generateOtpCode()
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000)
  await repo.createOtpCode({ adminId: admin.id, phone, code, expiresAt, requestedIp: ip })
  await audit(db, { actorType: 'system', action: 'auth.otp_requested', module: 'auth', actorId: admin.id, actorEmail: admin.email })

  // No SMS gateway wired up yet: the code is returned directly and kept in admin_otp_codes /
  // GET /auth/otp/logs so the login screen can show and auto-fill it during development.
  return { sent: true, devCode: code, expiresInSeconds: env.OTP_TTL_MINUTES * 60 }
}

export async function verifyOtp(phone: string, code: string, rememberMe: boolean, ctx: RequestContext): Promise<LoginResult> {
  const admin = (await repo.findAdminByPhone(toIndianE164(phone))) ?? (await repo.findFallbackAdminForOtp())
  if (!admin) throw otpInvalid()
  if (admin.status === 'disabled') throw authAccountDisabled()

  const row = await repo.findLatestPendingOtp(admin.id, phone)
  if (!row) throw otpInvalid('Request a new code.')
  if (new Date(row.expires_at) < new Date()) throw otpExpired()
  if (row.attempts >= 5) throw otpInvalid('Too many attempts. Request a new code.')

  if (row.code !== code) {
    await repo.incrementOtpAttempts(row.id)
    throw otpInvalid()
  }

  await repo.markOtpVerified(row.id)
  await repo.markLoginSuccess(admin.id, ctx.ip)
  const session = await createLoginSession(admin, rememberMe, ctx)
  await audit(db, { actorType: 'admin', actorId: admin.id, actorEmail: admin.email, action: 'auth.login_succeeded', module: 'auth', ip: ctx.ip, newValues: { rememberMe, method: 'otp', device: parseDeviceLabel(ctx.userAgent) } })
  return session
}

export async function otpLogs(phone: string) {
  if (env.NODE_ENV === 'production') throw notFound()
  const rows = await repo.listOtpLogsByPhone(phone, 5)
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    attempts: r.attempts,
    code: r.code,
    expiresAt: r.expires_at,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
  }))
}
