import { isDeepStrictEqual } from 'node:util'
import type { Kysely } from 'kysely'
import { env } from '../../config/env.js'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { ApiError, authAccountLocked, authInvalidCredentials, conflictDuplicate, notFound, validationFailed } from '../../lib/errors.js'
import { signAccessToken } from '../../lib/jwt.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { passwordPolicyIssues } from '../../lib/passwordPolicy.js'
import { cdnUrl, maskPhone } from '../../lib/present.js'
import { denySessions } from '../../lib/sessionDenylist.js'
import { storage } from '../../lib/storage.js'
import type { Bucket } from '../../lib/storage.js'
import { sendAccountLockedEmail, sendPasswordChangedEmail } from '../auth/auth.emails.js'
import * as authRepo from '../auth/auth.repository.js'
import type { Ctx as BaseCtx } from '../rbac/rbac.service.js'
import type { PatchProfileInput } from './profile.schemas.js'

export type Ctx = BaseCtx & { sessionId: string }

const STALE = 'Your profile changed in another tab. Reload.'
const IMAGE_ERROR = 'Upload a JPG, PNG or WebP image.'
const LOCK_AFTER = 5
const LOCK_MINUTES = 15

const auditBase = (ctx: Ctx) => ({
  actorType: 'admin' as const,
  actorId: ctx.actor.id,
  actorEmail: ctx.actor.email,
  module: 'profile',
  entityType: 'admin_profiles',
  entityId: ctx.actor.id,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  requestId: ctx.requestId,
})

// FR-3.1: the profile row is created lazily with its defaults the first time it is needed.
async function ensureProfile(adminId: string) {
  await db.insertInto('admin_profiles').values({ admin_id: adminId }).onConflict((oc) => oc.column('admin_id').doNothing()).execute()
}

async function load(adminId: string, executor: Kysely<DB> = db, lock = false) {
  let q = executor
    .selectFrom('admins')
    .innerJoin('admin_profiles', 'admin_profiles.admin_id', 'admins.id')
    .leftJoin('files', (join) => join.onRef('files.id', '=', 'admin_profiles.avatar_file_id').on('files.status', '=', 'uploaded').on('files.deleted_at', 'is', null))
    .select([
      'admins.id',
      'admins.email',
      'admins.full_name',
      'admins.last_login_at',
      'admin_profiles.display_name',
      'admin_profiles.phone',
      'admin_profiles.designation',
      'admin_profiles.avatar_file_id',
      'admin_profiles.timezone',
      'admin_profiles.locale',
      'admin_profiles.theme',
      'admin_profiles.notification_prefs',
      'admin_profiles.updated_at',
      'files.object_key as avatar_key',
    ])
    .where('admins.id', '=', adminId)
    .where('admins.deleted_at', 'is', null)
  if (lock) q = q.forUpdate('admin_profiles')
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('Admin not found.')
  return row
}

type Loaded = Awaited<ReturnType<typeof load>>

const prefsOf = (raw: unknown) => {
  const p = (raw ?? {}) as { email_digest?: boolean; queue_alerts?: boolean }
  return { email_digest: p.email_digest ?? true, queue_alerts: p.queue_alerts ?? true }
}

async function present(r: Loaded) {
  const roles = await db
    .selectFrom('admin_roles as ar')
    .innerJoin('roles as ro', 'ro.id', 'ar.role_id')
    .select('ro.name')
    .where('ar.admin_id', '=', r.id)
    .where('ro.deleted_at', 'is', null)
    .orderBy('ro.name')
    .execute()
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    displayName: r.display_name,
    designation: r.designation,
    phone: r.phone,
    avatar: r.avatar_file_id && r.avatar_key ? { fileId: r.avatar_file_id, url: cdnUrl(r.avatar_key) } : null,
    timezone: r.timezone,
    locale: r.locale,
    theme: r.theme,
    notificationPrefs: { ...prefsOf(r.notification_prefs), security_alerts: true },
    roles: roles.map((x) => x.name),
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    updatedAt: r.updated_at.toISOString(),
  }
}

export async function getProfile(adminId: string) {
  await ensureProfile(adminId)
  return present(await load(adminId))
}

// FR-3.2
export async function patchProfile(ctx: Ctx, version: Date, input: PatchProfileInput) {
  await ensureProfile(ctx.actor.id)
  return db.transaction().execute(async (trx) => {
    const row = await load(ctx.actor.id, trx, true)
    if (row.updated_at.getTime() !== version.getTime()) throw new ApiError(409, 'VERSION_CONFLICT', STALE, { current: await present(row) })

    const prefs = input.notificationPrefs ? { ...prefsOf(row.notification_prefs), ...input.notificationPrefs } : undefined
    const before: Record<string, unknown> = {
      fullName: row.full_name,
      displayName: row.display_name,
      designation: row.designation,
      phone: row.phone,
      timezone: row.timezone,
      locale: row.locale,
      theme: row.theme,
      notificationPrefs: prefsOf(row.notification_prefs),
    }
    const wanted: Record<string, unknown> = { ...input, ...(prefs ? { notificationPrefs: prefs } : {}) }
    const changed = Object.keys(wanted).filter((k) => !isDeepStrictEqual(wanted[k], before[k]))
    if (changed.length === 0) return present(row)

    // The phone doubles as the OTP sign-in identity, so two admins can't share one.
    if (changed.includes('phone') && input.phone) {
      const taken = await trx.selectFrom('admin_profiles').select('admin_id').where('phone', '=', input.phone).where('admin_id', '!=', ctx.actor.id).executeTakeFirst()
      if (taken) throw conflictDuplicate('Another admin already uses this phone number.')
    }

    if (changed.includes('fullName')) await trx.updateTable('admins').set({ full_name: input.fullName!, updated_by: ctx.actor.id }).where('id', '=', ctx.actor.id).execute()
    // Always touch the profile row: its updated_at is the version token for the whole page, including the name.
    await trx
      .updateTable('admin_profiles')
      .set({
        ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
        ...(input.designation !== undefined ? { designation: input.designation } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.theme ? { theme: input.theme } : {}),
        ...(prefs ? { notification_prefs: JSON.stringify(prefs) as never } : {}),
        updated_at: new Date(),
      })
      .where('admin_id', '=', ctx.actor.id)
      .execute()

    const mask = (k: string, v: unknown) => (k === 'phone' ? maskPhone(v as string | null) : v)
    await audit(trx, {
      ...auditBase(ctx),
      action: 'admin_profile.updated',
      oldValues: Object.fromEntries(changed.map((k) => [k, mask(k, before[k])])),
      newValues: Object.fromEntries(changed.map((k) => [k, mask(k, wanted[k])])),
    })
    return present(await load(ctx.actor.id, trx))
  })
}

// FR-3.3 -------------------------------------------------------------------------------------------------------

async function discardFile(fileId: string) {
  const file = await db
    .updateTable('files')
    .set({ status: 'deleted', deleted_at: new Date() })
    .where('id', '=', fileId)
    .where('deleted_at', 'is', null)
    .returning(['bucket', 'object_key'])
    .executeTakeFirst()
  if (file) await storage.delete(file.bucket as Bucket, file.object_key).catch(() => undefined)
}

export async function setAvatar(ctx: Ctx, fileId: string) {
  await ensureProfile(ctx.actor.id)
  const file = await db
    .selectFrom('files')
    .select(['id', 'mime_type', 'purpose', 'status', 'uploaded_by_type', 'uploaded_by_id', 'deleted_at'])
    .where('id', '=', fileId)
    .executeTakeFirst()
  const usable =
    file &&
    file.deleted_at === null &&
    file.status === 'uploaded' &&
    file.purpose === 'admin_avatar' &&
    file.uploaded_by_type === 'admin' &&
    file.uploaded_by_id === ctx.actor.id &&
    file.mime_type.startsWith('image/')
  if (!usable) throw validationFailed([{ path: 'fileId', message: IMAGE_ERROR }], IMAGE_ERROR)

  const previous = await db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('admin_profiles').select('avatar_file_id').where('admin_id', '=', ctx.actor.id).forUpdate().executeTakeFirstOrThrow()
    if (current.avatar_file_id === fileId) return null
    await trx.updateTable('admin_profiles').set({ avatar_file_id: fileId }).where('admin_id', '=', ctx.actor.id).execute()
    await audit(trx, { ...auditBase(ctx), action: 'admin_profile.avatar_changed', oldValues: { fileId: current.avatar_file_id }, newValues: { fileId } })
    return current.avatar_file_id
  })
  if (previous) await discardFile(previous)
  return present(await load(ctx.actor.id))
}

export async function removeAvatar(ctx: Ctx) {
  await ensureProfile(ctx.actor.id)
  const previous = await db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('admin_profiles').select('avatar_file_id').where('admin_id', '=', ctx.actor.id).forUpdate().executeTakeFirstOrThrow()
    if (!current.avatar_file_id) return null
    await trx.updateTable('admin_profiles').set({ avatar_file_id: null }).where('admin_id', '=', ctx.actor.id).execute()
    await audit(trx, { ...auditBase(ctx), action: 'admin_profile.avatar_removed', oldValues: { fileId: current.avatar_file_id } })
    return current.avatar_file_id
  })
  if (previous) await discardFile(previous)
  return present(await load(ctx.actor.id))
}

// FR-3.4 -------------------------------------------------------------------------------------------------------

export async function changePassword(ctx: Ctx, input: { currentPassword: string; newPassword: string; signOutOtherSessions: boolean }) {
  const admin = await authRepo.findAdminById(ctx.actor.id)
  if (!admin) throw notFound('Admin not found.')

  if (admin.locked_until && admin.locked_until > new Date()) {
    throw authAccountLocked(admin.locked_until.toISOString(), `Too many attempts. Try again after ${admin.locked_until.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`)
  }

  // A wrong current password counts toward the same lockout as sign-in.
  if (!(await verifyPassword(admin.password_hash, input.currentPassword))) {
    const lockUntil = admin.failed_login_count + 1 >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null
    await authRepo.incrementFailedLogin(admin.id, lockUntil)
    await audit(db, { ...auditBase(ctx), module: 'auth', entityType: 'admin', action: 'auth.password_change_failed', reason: 'bad_current_password' })
    if (lockUntil) {
      await audit(db, { actorType: 'system', action: 'auth.account_locked', module: 'auth', actorId: admin.id, actorEmail: admin.email, newValues: { lockedUntil: lockUntil } })
      await sendAccountLockedEmail(admin.email, lockUntil)
    }
    throw authInvalidCredentials('Your current password is incorrect.')
  }

  const issues = passwordPolicyIssues(input.newPassword, { email: admin.email, fullName: admin.full_name })
  if (issues.length > 0) {
    throw validationFailed(
      issues.map((message) => ({ path: 'newPassword', message })),
      issues[0],
    )
  }
  if (input.newPassword === input.currentPassword) {
    const message = "Choose a password you haven't used before."
    throw validationFailed([{ path: 'newPassword', message }], message)
  }

  await authRepo.updateAdminPassword(admin.id, await hashPassword(input.newPassword))
  const revoked = input.signOutOtherSessions ? await authRepo.revokeAllSessionsForAdmin(admin.id, 'password_changed', ctx.sessionId) : []
  await denySessions(revoked)
  await audit(db, { ...auditBase(ctx), module: 'auth', entityType: 'admin', action: 'auth.password_changed', newValues: { sessionsRevoked: revoked.length } })
  await sendPasswordChangedEmail(admin.email)

  // The password version is baked into every access token, so the one this request used just died: hand back a
  // fresh one for the same session.
  const fresh = await authRepo.findAdminById(admin.id)
  const accessToken = signAccessToken({
    sub: admin.id,
    sid: ctx.sessionId,
    sa: admin.is_super_admin,
    pwd: Math.floor(new Date(fresh!.password_changed_at).getTime() / 1000),
  })
  return { accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, sessionsRevoked: revoked.length }
}
