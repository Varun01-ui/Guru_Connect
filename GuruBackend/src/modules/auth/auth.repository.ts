import { db } from '../../db/index.js'

export function findAdminByEmail(email: string) {
  return db.selectFrom('admins').selectAll().where('email', '=', email).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findAdminById(id: string) {
  return db.selectFrom('admins').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()
}

export function incrementFailedLogin(id: string, lockUntil: Date | null) {
  return db
    .updateTable('admins')
    .set((eb) => ({
      failed_login_count: eb('failed_login_count', '+', 1),
      ...(lockUntil ? { locked_until: lockUntil, status: 'locked' as const } : {}),
    }))
    .where('id', '=', id)
    .execute()
}

export function markLoginSuccess(id: string, ip: string | null) {
  return db
    .updateTable('admins')
    .set({
      failed_login_count: 0,
      locked_until: null,
      status: 'active',
      last_login_at: new Date(),
      last_login_ip: ip,
    })
    .where('id', '=', id)
    .execute()
}

export async function updateAdminPassword(id: string, passwordHash: string) {
  await db
    .updateTable('admins')
    .set({ password_hash: passwordHash, password_changed_at: new Date(), failed_login_count: 0, locked_until: null })
    .where('id', '=', id)
    .execute()
  // invited/locked accounts become active once they hold a working password; disabled stays disabled.
  await db.updateTable('admins').set({ status: 'active' }).where('id', '=', id).where('status', 'in', ['invited', 'locked']).execute()
}

export function createSession(input: {
  adminId: string
  refreshTokenHash: string
  ipAddress: string | null
  userAgent: string | null
  deviceLabel: string | null
  expiresAt: Date
}) {
  return db
    .insertInto('admin_sessions')
    .values({
      admin_id: input.adminId,
      refresh_token_hash: input.refreshTokenHash,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      device_label: input.deviceLabel,
      expires_at: input.expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export function findSessionByRefreshHash(hash: string) {
  return db.selectFrom('admin_sessions').selectAll().where('refresh_token_hash', '=', hash).executeTakeFirst()
}

export function findActiveSessionByPreviousHash(hash: string) {
  return db
    .selectFrom('admin_sessions')
    .selectAll()
    .where('previous_token_hash', '=', hash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
}

// Compare-and-swap on the presented hash so two parallel refreshes can't both rotate the same token.
// Resolves to false when someone else already rotated it.
export async function rotateSession(sessionId: string, input: { newHash: string; previousHash: string }): Promise<boolean> {
  const result = await db
    .updateTable('admin_sessions')
    .set({
      refresh_token_hash: input.newHash,
      previous_token_hash: input.previousHash,
      last_used_at: new Date(),
    })
    .where('id', '=', sessionId)
    .where('refresh_token_hash', '=', input.previousHash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export async function revokeSession(sessionId: string, reason: string): Promise<string[]> {
  const rows = await db
    .updateTable('admin_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason as never })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()
  return rows.map((r) => r.id)
}

export async function revokeSessionFamily(tokenFamily: string, reason: string): Promise<string[]> {
  const rows = await db
    .updateTable('admin_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason as never })
    .where('token_family', '=', tokenFamily)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()
  return rows.map((r) => r.id)
}

export async function revokeAllSessionsForAdmin(adminId: string, reason: string, exceptSessionId?: string): Promise<string[]> {
  let query = db
    .updateTable('admin_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason as never })
    .where('admin_id', '=', adminId)
    .where('revoked_at', 'is', null)
  if (exceptSessionId) query = query.where('id', '!=', exceptSessionId)
  const rows = await query.returning('id').execute()
  return rows.map((r) => r.id)
}

// An admin keeps at most `max` live sessions; the least recently used ones beyond that are revoked.
export async function revokeSessionsOverCap(adminId: string, max: number): Promise<string[]> {
  const live = await db
    .selectFrom('admin_sessions')
    .select('id')
    .where('admin_id', '=', adminId)
    .where('revoked_at', 'is', null)
    .orderBy('last_used_at', 'desc')
    .execute()
  const excess = live.slice(max).map((r) => r.id)
  if (excess.length === 0) return []
  await db
    .updateTable('admin_sessions')
    .set({ revoked_at: new Date(), revoked_reason: 'expired' })
    .where('id', 'in', excess)
    .execute()
  return excess
}

export function listSessions(adminId: string) {
  return db
    .selectFrom('admin_sessions')
    .selectAll()
    .where('admin_id', '=', adminId)
    .where('revoked_at', 'is', null)
    .orderBy('last_used_at', 'desc')
    .execute()
}

export function findOwnSession(adminId: string, sessionId: string) {
  return db
    .selectFrom('admin_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .where('admin_id', '=', adminId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
}

export function createPasswordResetToken(input: {
  adminId: string
  tokenHash: string
  purpose: 'reset' | 'invite'
  expiresAt: Date
  requestedIp: string | null
}) {
  return db
    .insertInto('password_reset_tokens')
    .values({
      admin_id: input.adminId,
      token_hash: input.tokenHash,
      purpose: input.purpose,
      expires_at: input.expiresAt,
      requested_ip: input.requestedIp,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export function invalidateUnusedResetTokens(adminId: string) {
  return db.deleteFrom('password_reset_tokens').where('admin_id', '=', adminId).where('used_at', 'is', null).execute()
}

export function findValidResetToken(tokenHash: string) {
  return db
    .selectFrom('password_reset_tokens')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst()
}

// Claims the token; resolves to false if it was already used (two concurrent submissions of one link).
export async function markResetTokenUsed(id: string): Promise<boolean> {
  const result = await db
    .updateTable('password_reset_tokens')
    .set({ used_at: new Date() })
    .where('id', '=', id)
    .where('used_at', 'is', null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export function getAdminProfile(adminId: string) {
  return db.selectFrom('admin_profiles').selectAll().where('admin_id', '=', adminId).executeTakeFirst()
}

export function findAdminByPhone(phone: string) {
  return db
    .selectFrom('admins')
    .innerJoin('admin_profiles', 'admin_profiles.admin_id', 'admins.id')
    .selectAll('admins')
    .where('admin_profiles.phone', '=', phone)
    .where('admins.deleted_at', 'is', null)
    .executeTakeFirst()
}

// Dev/demo fallback: while there's no SMS gateway and only a handful of admins exist, OTP login
// works for any 10-digit number by falling back to the (first) active super admin.
export function findFallbackAdminForOtp() {
  return db
    .selectFrom('admins')
    .selectAll()
    .where('is_super_admin', '=', true)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .executeTakeFirst()
}

export function createOtpCode(input: { adminId: string; phone: string; code: string; expiresAt: Date; requestedIp: string | null }) {
  return db
    .insertInto('admin_otp_codes')
    .values({
      admin_id: input.adminId,
      phone: input.phone,
      code: input.code,
      expires_at: input.expiresAt,
      requested_ip: input.requestedIp,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export function findLatestPendingOtp(adminId: string, phone: string) {
  return db
    .selectFrom('admin_otp_codes')
    .selectAll()
    .where('admin_id', '=', adminId)
    .where('phone', '=', phone)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
}

export function incrementOtpAttempts(id: string) {
  return db
    .updateTable('admin_otp_codes')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', id)
    .execute()
}

export function markOtpVerified(id: string) {
  return db.updateTable('admin_otp_codes').set({ status: 'verified', verified_at: new Date() }).where('id', '=', id).execute()
}

export function expirePendingOtps(adminId: string, phone: string) {
  return db
    .updateTable('admin_otp_codes')
    .set({ status: 'expired' })
    .where('admin_id', '=', adminId)
    .where('phone', '=', phone)
    .where('status', '=', 'pending')
    .execute()
}

export function listOtpLogsByPhone(phone: string, limit: number) {
  return db
    .selectFrom('admin_otp_codes')
    .select(['id', 'phone', 'code', 'status', 'attempts', 'expires_at', 'verified_at', 'created_at'])
    .where('phone', '=', phone)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
}

// Nightly retention (M01 §22): expired/revoked sessions older than 30 days, used/expired reset tokens older than 7.
export async function deleteStaleSessions(olderThan: Date) {
  const result = await db
    .deleteFrom('admin_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', olderThan), eb('revoked_at', '<', olderThan)]))
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

export async function deleteStaleResetTokens(olderThan: Date) {
  const result = await db
    .deleteFrom('password_reset_tokens')
    .where((eb) => eb.or([eb('expires_at', '<', olderThan), eb('used_at', '<', olderThan)]))
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

export function createInvitedAdmin(input: { email: string; fullName: string; passwordHash: string; isSuperAdmin: boolean }) {
  return db
    .insertInto('admins')
    .values({
      email: input.email,
      full_name: input.fullName,
      password_hash: input.passwordHash,
      is_super_admin: input.isSuperAdmin,
      status: 'invited',
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow()
}
