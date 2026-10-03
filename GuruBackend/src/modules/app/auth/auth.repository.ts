import { randomBytes, randomUUID } from 'node:crypto'
import { db } from '../../../db/index.js'
import { sha256Hex } from '../../../lib/tokens.js'

export function hashRefreshToken(token: string): string {
  return sha256Hex(token)
}

export async function createOtpChallenge(input: {
  channel: 'sms' | 'email'
  destination: string
  purpose: 'login' | 'signup' | 'reset_password'
  codeHash: string
  userId: string | null
  ipAddress: string | null
  installId: string | null
  ttlSeconds: number
}) {
  return db
    .insertInto('otp_challenges')
    .values({
      channel: input.channel,
      destination: input.destination,
      purpose: input.purpose,
      code_hash: input.codeHash,
      user_id: input.userId,
      ip_address: input.ipAddress,
      install_id: input.installId,
      expires_at: new Date(Date.now() + input.ttlSeconds * 1000),
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow()
}

export function findActiveChallenge(challengeId: string) {
  return db.selectFrom('otp_challenges').selectAll().where('id', '=', challengeId).where('consumed_at', 'is', null).executeTakeFirst()
}

export function incrementAttempts(challengeId: string) {
  return db
    .updateTable('otp_challenges')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', challengeId)
    .returning('attempts')
    .executeTakeFirstOrThrow()
}

export function consumeChallenge(challengeId: string) {
  return db.updateTable('otp_challenges').set({ verified_at: new Date(), consumed_at: new Date() }).where('id', '=', challengeId).execute()
}

export function findUserByPhone(phone: string) {
  return db.selectFrom('app_users').selectAll().where('phone', '=', phone).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findUserByEmail(email: string) {
  return db.selectFrom('app_users').selectAll().where('email', '=', email).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findUserById(userId: string) {
  return db.selectFrom('app_users').selectAll().where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst()
}

// pid claim: parents.id / students.id / teachers.id, or institute_managers.id for institute staff (whose iid claim is the
// institute). Staff without an active manager row get no pid.
export async function findProfileForUser(userId: string, userType: string): Promise<{ profileId: string | null; instituteId: string | null }> {
  if (userType === 'institute_staff') {
    const row = await db.selectFrom('institute_managers').select(['id', 'institute_id']).where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst()
    return { profileId: row?.id ?? null, instituteId: row?.institute_id ?? null }
  }
  const table = userType === 'parent' ? 'parents' : userType === 'student' ? 'students' : userType === 'teacher' ? 'teachers' : null
  if (!table) return { profileId: null, instituteId: null }
  const row = await db.selectFrom(table).select('id').where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst()
  return { profileId: row?.id ?? null, instituteId: null }
}

export async function findProfileIdForUser(userId: string, userType: string): Promise<string | null> {
  return (await findProfileForUser(userId, userType)).profileId
}

export async function createSession(input: {
  userId: string
  authMethod: 'otp' | 'password' | 'google' | 'email_otp'
  ipAddress: string | null
  userAgent: string | null
}) {
  const refreshToken = randomBytes(32).toString('hex')
  const tokenFamily = randomUUID()
  const session = await db
    .insertInto('app_sessions')
    .values({
      user_id: input.userId,
      refresh_token_hash: hashRefreshToken(refreshToken),
      token_family: tokenFamily,
      auth_method: input.authMethod,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
  return { sessionId: session.id, refreshToken, tokenFamily }
}

export function findSessionByRefreshToken(refreshToken: string) {
  return db.selectFrom('app_sessions').selectAll().where('refresh_token_hash', '=', hashRefreshToken(refreshToken)).executeTakeFirst()
}

// A rotated-out token no longer matches refresh_token_hash (it was overwritten), so replay of an
// old token is detected here instead — this is what lets refreshSession revoke the whole family.
export function findActiveSessionByPreviousHash(hash: string) {
  return db
    .selectFrom('app_sessions')
    .selectAll()
    .where('previous_token_hash', '=', hash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
}

export function rotateSession(sessionId: string, currentTokenHash: string, newRefreshToken: string) {
  return db
    .updateTable('app_sessions')
    .set({
      refresh_token_hash: hashRefreshToken(newRefreshToken),
      previous_token_hash: currentTokenHash,
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .where('id', '=', sessionId)
    .execute()
}

export function revokeSessionById(sessionId: string, reason: string) {
  return db.updateTable('app_sessions').set({ revoked_at: new Date(), revoked_reason: reason as never }).where('id', '=', sessionId).execute()
}

export function revokeTokenFamily(tokenFamily: string, reason: string) {
  return db
    .updateTable('app_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason as never })
    .where('token_family', '=', tokenFamily)
    .where('revoked_at', 'is', null)
    .execute()
}

export function revokeAllSessionsForUser(userId: string, reason: string) {
  return db
    .updateTable('app_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason as never })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute()
}

export async function listActiveSessions(userId: string, currentSessionId: string) {
  const rows = await db
    .selectFrom('app_sessions')
    .select(['id', 'user_agent', 'last_used_at', 'created_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('last_used_at', 'desc')
    .execute()

  return rows.map((r) => ({
    id: r.id,
    deviceLabel: r.user_agent ?? 'Unknown device',
    isCurrent: r.id === currentSessionId,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }))
}

export function findPasswordIdentity(email: string) {
  return db
    .selectFrom('user_auth_identities')
    .selectAll()
    .where('provider', '=', 'password')
    .where('provider_subject', '=', email)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export function findGoogleIdentity(subject: string) {
  return db
    .selectFrom('user_auth_identities')
    .selectAll()
    .where('provider', '=', 'google')
    .where('provider_subject', '=', subject)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export function recordFailedPasswordAttempt(identityId: string, failedAttempts: number) {
  const lockUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
  return db
    .updateTable('user_auth_identities')
    .set({ failed_attempts: failedAttempts, locked_until: lockUntil })
    .where('id', '=', identityId)
    .execute()
}

export function resetPasswordAttempts(identityId: string) {
  return db
    .updateTable('user_auth_identities')
    .set({ failed_attempts: 0, locked_until: null, last_used_at: new Date() })
    .where('id', '=', identityId)
    .execute()
}

export function updatePassword(identityId: string, passwordHash: string) {
  return db
    .updateTable('user_auth_identities')
    .set({ password_hash: passwordHash, password_updated_at: new Date(), failed_attempts: 0, locked_until: null })
    .where('id', '=', identityId)
    .execute()
}

export function insertPasswordIdentity(userId: string, email: string, passwordHash: string) {
  return db
    .insertInto('user_auth_identities')
    .values({ user_id: userId, provider: 'password', provider_subject: email, email, password_hash: passwordHash })
    .execute()
}

export function linkGoogleIdentity(userId: string, subject: string, email: string) {
  return db.insertInto('user_auth_identities').values({ user_id: userId, provider: 'google', provider_subject: subject, email }).execute()
}
