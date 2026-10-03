import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { z } from 'zod'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, notFound, validationFailed } from '../../lib/errors.js'
import { hashPassword } from '../../lib/password.js'
import { allPermissionKeys, bustPermissionCache } from '../../lib/permissions.js'
import { denySessions } from '../../lib/sessionDenylist.js'
import { generateOpaqueToken, sha256Hex } from '../../lib/tokens.js'
import { sendInviteEmail } from '../auth/auth.emails.js'
import type { adminListQuerySchema, createRoleSchema, inviteAdminSchema, patchRoleSchema } from './rbac.schemas.js'
import type { AppTrx } from '../app/registration/registration.repository.js'

export type Actor = { id: string; email: string; isSuperAdmin: boolean }
export type Ctx = { actor: Actor; ip: string | null; userAgent: string | null; requestId: string | null }

const INVITE_TTL_MS = 72 * 3_600_000
const SUPER_ADMIN_CODE = 'super_admin'

const msg = {
  noReasonSensitive: 'Add a reason for granting sensitive permissions.',
  lastSuper: "You can't remove the last active Super Admin.",
}

const fieldError = (path: string, message: string) => validationFailed([{ path, message }], message)

function auditBase(ctx: Ctx, entityType: string, entityId: string) {
  return { actorType: 'admin' as const, actorId: ctx.actor.id, actorEmail: ctx.actor.email, module: 'rbac', entityType, entityId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId }
}

// ---------------------------------------------------------------- roles

const ROLE_COLUMNS = ['id', 'code', 'name', 'description', 'is_system', 'updated_at'] as const

async function loadRole(id: string, executor: typeof db | AppTrx = db, lock = false) {
  let q = executor.selectFrom('roles').select(ROLE_COLUMNS).where('id', '=', id).where('deleted_at', 'is', null)
  if (lock) q = q.forUpdate()
  const role = await q.executeTakeFirst()
  if (!role) throw notFound('This role no longer exists.')
  return role
}

async function permissionKeysOf(roleId: string, executor: typeof db | AppTrx = db): Promise<string[]> {
  const rows = await executor.selectFrom('role_permissions as rp').innerJoin('permissions as p', 'p.id', 'rp.permission_id').select('p.key').where('rp.role_id', '=', roleId).orderBy('p.key').execute()
  return rows.map((r) => r.key)
}

async function holderIds(roleId: string, executor: typeof db | AppTrx = db): Promise<string[]> {
  const rows = await executor.selectFrom('admin_roles').select('admin_id').where('role_id', '=', roleId).execute()
  return rows.map((r) => r.admin_id)
}

export async function listPermissions() {
  const rows = await db.selectFrom('permissions').select(['key', 'module', 'description', 'is_sensitive']).orderBy('module').orderBy('key').execute()
  const byModule = new Map<string, { key: string; description: string; isSensitive: boolean }[]>()
  for (const r of rows) byModule.set(r.module, [...(byModule.get(r.module) ?? []), { key: r.key, description: r.description, isSensitive: r.is_sensitive }])
  return [...byModule].map(([module, permissions]) => ({ module, permissions }))
}

export async function listRoles() {
  const rows = await sql<{ id: string; code: string; name: string; description: string | null; is_system: boolean; updated_at: Date; permission_count: number; admin_count: number }>`
    select r.id, r.code, r.name, r.description, r.is_system, r.updated_at,
      (select count(*)::int from role_permissions rp where rp.role_id = r.id) as permission_count,
      (select count(*)::int from admin_roles ar join admins a on a.id = ar.admin_id where ar.role_id = r.id and a.deleted_at is null) as admin_count
    from roles r where r.deleted_at is null order by r.is_system desc, r.name`.execute(db)
  return rows.rows.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, isSystem: r.is_system, permissionCount: r.permission_count, adminCount: r.admin_count, updatedAt: r.updated_at.toISOString() }))
}

export async function getRole(id: string) {
  const role = await loadRole(id)
  const admins = await db
    .selectFrom('admin_roles as ar')
    .innerJoin('admins as a', 'a.id', 'ar.admin_id')
    .select(['a.id', 'a.full_name', 'a.email'])
    .where('ar.role_id', '=', id)
    .where('a.deleted_at', 'is', null)
    .orderBy('a.full_name')
    .execute()
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isSystem: role.is_system,
    // Super Admin implicitly holds everything, whatever rows role_permissions has.
    permissionKeys: role.code === SUPER_ADMIN_CODE ? await allPermissionKeys() : await permissionKeysOf(id),
    admins: admins.map((a) => ({ id: a.id, fullName: a.full_name, email: a.email })),
    updatedAt: role.updated_at.toISOString(),
  }
}

async function sensitiveAmong(keys: string[], executor: typeof db | AppTrx = db): Promise<string[]> {
  if (keys.length === 0) return []
  const rows = await executor.selectFrom('permissions').select('key').where('key', 'in', keys).where('is_sensitive', '=', true).orderBy('key').execute()
  return rows.map((r) => r.key)
}

// Unknown or duplicated keys never reach the database: they are reported by name (FR-2.1, section 20).
async function assertKnownKeys(keys: string[]): Promise<void> {
  const seen = new Set<string>()
  const dups = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)))
  if (dups.length) throw validationFailed(dups.map((k) => ({ path: 'permissionKeys', message: `Duplicate permission: ${k}` })), `Duplicate permission: ${dups[0]}`)
  if (keys.length === 0) return
  const known = new Set((await db.selectFrom('permissions').select('key').where('key', 'in', keys).execute()).map((r) => r.key))
  const unknown = keys.filter((k) => !known.has(k))
  if (unknown.length) throw validationFailed(unknown.map((k) => ({ path: 'permissionKeys', message: `Unknown permission: ${k}` })), `Unknown permission: ${unknown[0]}`)
}

function requireReasonForSensitive(sensitive: string[], reason: string | undefined) {
  if (sensitive.length > 0 && !reason) throw validationFailed([{ path: 'reason', message: msg.noReasonSensitive, sensitiveKeys: sensitive }], msg.noReasonSensitive)
}

function slugCode(name: string) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role'
}

const duplicateName = () => new ApiError(409, 'CONFLICT_DUPLICATE', 'A role with this name already exists.')

export async function createRole(ctx: Ctx, body: z.infer<typeof createRoleSchema>) {
  let keys: string[]
  if (body.permissionKeys) keys = body.permissionKeys
  else if (body.copyFromRoleId) {
    const source = await loadRole(body.copyFromRoleId)
    keys = source.code === SUPER_ADMIN_CODE ? await allPermissionKeys() : await permissionKeysOf(source.id)
  } else keys = []
  await assertKnownKeys(keys)
  requireReasonForSensitive(await sensitiveAmong(keys), body.reason)

  let roleId: string
  try {
    roleId = await db.transaction().execute(async (trx) => {
      const clash = await trx.selectFrom('roles').select('id').where(sql<boolean>`lower(name) = lower(${body.name})`).where('deleted_at', 'is', null).executeTakeFirst()
      if (clash) throw duplicateName()
      let code = slugCode(body.name)
      for (let n = 2; await trx.selectFrom('roles').select('id').where('code', '=', code).where('deleted_at', 'is', null).executeTakeFirst(); n++) code = `${slugCode(body.name)}_${n}`

      const role = await trx
        .insertInto('roles')
        .values({ code, name: body.name, description: body.description?.trim() || null, is_system: false, created_by: ctx.actor.id, updated_by: ctx.actor.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      if (keys.length) {
        await trx
          .insertInto('role_permissions')
          .columns(['role_id', 'permission_id', 'granted_by'])
          .expression((eb) => eb.selectFrom('permissions').select([sql<string>`${role.id}::uuid`.as('role_id'), 'id', sql<string>`${ctx.actor.id}::uuid`.as('granted_by')]).where('key', 'in', keys))
          .execute()
      }
      await audit(trx, { ...auditBase(ctx, 'role', role.id), action: 'role.created', newValues: { name: body.name, description: body.description ?? null, code, permissionCount: keys.length, copiedFrom: body.copyFromRoleId ?? null }, reason: body.reason ?? null })
      return role.id
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') throw duplicateName()
    throw err
  }
  return getRole(roleId)
}

export async function patchRole(ctx: Ctx, id: string, version: Date | null, body: z.infer<typeof patchRoleSchema>) {
  await db.transaction().execute(async (trx) => {
    const role = await loadRole(id, trx, true)
    if (version && Math.abs(role.updated_at.getTime() - version.getTime()) >= 1) throw await versionConflictFor(id)
    if (body.name !== undefined && body.name !== role.name) {
      if (role.is_system) throw conflictState("System roles can't be renamed.")
      const clash = await trx.selectFrom('roles').select('id').where(sql<boolean>`lower(name) = lower(${body.name})`).where('id', '<>', id).where('deleted_at', 'is', null).executeTakeFirst()
      if (clash) throw duplicateName()
    }
    const changes: Record<string, { old: unknown; new: unknown }> = {}
    if (body.name !== undefined && body.name !== role.name) changes.name = { old: role.name, new: body.name }
    if (body.description !== undefined && (body.description?.trim() || null) !== role.description) changes.description = { old: role.description, new: body.description?.trim() || null }
    if (Object.keys(changes).length === 0) return
    await trx
      .updateTable('roles')
      .set({ ...(changes.name ? { name: body.name! } : {}), ...(changes.description ? { description: body.description?.trim() || null } : {}), updated_by: ctx.actor.id })
      .where('id', '=', id)
      .execute()
    await audit(trx, { ...auditBase(ctx, 'role', id), action: 'role.updated', oldValues: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.old])), newValues: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.new])) })
  })
  return getRole(id)
}

async function versionConflictFor(id: string) {
  return new ApiError(409, 'VERSION_CONFLICT', 'Someone else changed this role. Reload to see their changes.', { current: await getRole(id) })
}

export async function putRolePermissions(ctx: Ctx, id: string, version: Date, body: { permissionKeys: string[]; reason?: string }) {
  const existing = await loadRole(id)
  if (existing.code === SUPER_ADMIN_CODE) throw conflictState('Super Admin always has every permission.')
  await assertKnownKeys(body.permissionKeys)

  const affected = await db.transaction().execute(async (trx) => {
    const role = await loadRole(id, trx, true)
    if (Math.abs(role.updated_at.getTime() - version.getTime()) >= 1) throw await versionConflictFor(id)

    const current = new Set(await permissionKeysOf(id, trx))
    const wanted = new Set(body.permissionKeys)
    const added = [...wanted].filter((k) => !current.has(k)).sort()
    const removed = [...current].filter((k) => !wanted.has(k)).sort()
    requireReasonForSensitive(await sensitiveAmong(added, trx), body.reason)
    if (added.length === 0 && removed.length === 0) return [] as string[]

    if (removed.length) await trx.deleteFrom('role_permissions').where('role_id', '=', id).where('permission_id', 'in', trx.selectFrom('permissions').select('id').where('key', 'in', removed)).execute()
    if (added.length) {
      await trx
        .insertInto('role_permissions')
        .columns(['role_id', 'permission_id', 'granted_by'])
        .expression((eb) => eb.selectFrom('permissions').select([sql<string>`${id}::uuid`.as('role_id'), 'id', sql<string>`${ctx.actor.id}::uuid`.as('granted_by')]).where('key', 'in', added))
        .execute()
    }
    // Touching the row moves updated_at, which is the version the next editor must present.
    await trx.updateTable('roles').set({ updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, 'role', id), action: 'role.permissions_changed', newValues: { added, removed }, reason: body.reason ?? null })
    return holderIds(id, trx)
  })

  await bustPermissionCache(affected)
  return getRole(id)
}

export async function deleteRole(ctx: Ctx, id: string) {
  await db.transaction().execute(async (trx) => {
    const role = await loadRole(id, trx, true)
    if (role.is_system) throw conflictState("System roles can't be deleted.")
    const holders = await trx
      .selectFrom('admin_roles as ar')
      .innerJoin('admins as a', 'a.id', 'ar.admin_id')
      .select(['a.id', 'a.full_name'])
      .where('ar.role_id', '=', id)
      .where('a.deleted_at', 'is', null)
      .execute()
    if (holders.length > 0) {
      throw new ApiError(409, 'CONFLICT_IN_USE', `Remove this role from ${holders.length} admins first.`, { references: holders.map((h) => ({ id: h.id, fullName: h.full_name })) })
    }
    await trx.updateTable('roles').set({ deleted_at: new Date(), deleted_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, 'role', id), action: 'role.deleted', oldValues: { name: role.name, code: role.code } })
  })
}

// ---------------------------------------------------------------- admins

type RoleRef = { id: string; code: string; name: string }

async function rolesOf(adminIds: string[]): Promise<Map<string, RoleRef[]>> {
  const map = new Map<string, RoleRef[]>()
  if (adminIds.length === 0) return map
  const rows = await db
    .selectFrom('admin_roles as ar')
    .innerJoin('roles as r', 'r.id', 'ar.role_id')
    .select(['ar.admin_id', 'r.id', 'r.code', 'r.name'])
    .where('ar.admin_id', 'in', adminIds)
    .where('r.deleted_at', 'is', null)
    .orderBy('r.name')
    .execute()
  for (const r of rows) map.set(r.admin_id, [...(map.get(r.admin_id) ?? []), { id: r.id, code: r.code, name: r.name }])
  return map
}

const SORTABLE: Record<string, string> = { fullName: 'a.full_name', email: 'a.email', createdAt: 'a.created_at', lastLoginAt: 'a.last_login_at', status: 'a.status' }

export async function listAdmins(query: z.infer<typeof adminListQuerySchema>) {
  const sorts = (query.sort ?? 'createdAt:desc').split(',').map((s) => {
    const [field, dir] = s.split(':') as [string, 'asc' | 'desc']
    if (!SORTABLE[field]) throw validationFailed([{ path: 'sort', message: `Cannot sort by ${field}.` }], `Cannot sort by ${field}.`)
    return { column: SORTABLE[field]!, dir }
  })

  const filters = [sql`a.deleted_at is null`]
  if (query.status?.length) filters.push(sql`a.status = any(${query.status})`)
  if (query.roleId) filters.push(sql`exists (select 1 from admin_roles ar where ar.admin_id = a.id and ar.role_id = ${query.roleId})`)
  if (query.lastLogin === 'never') filters.push(sql`a.last_login_at is null`)
  if (query.lastLogin === 'stale30') filters.push(sql`a.last_login_at < now() - interval '30 days'`)
  if (query.q) {
    const like = query.q.replace(/[%_\\]/g, (c) => `\\${c}`)
    filters.push(sql`(a.full_name % ${query.q} or a.full_name ilike ${`%${like}%`} or a.email ilike ${`${like}%`})`)
  }
  const where = sql.join(filters, sql` and `)
  const order = sql.join([...sorts.map((s) => sql`${sql.raw(s.column)} ${sql.raw(s.dir)} nulls last`), sql`a.id`], sql`, `)

  const [rows, total] = await Promise.all([
    sql<{ id: string; email: string; full_name: string; status: string; is_super_admin: boolean; last_login_at: Date | null; created_at: Date }>`
      select a.id, a.email, a.full_name, a.status, a.is_super_admin, a.last_login_at, a.created_at
      from admins a where ${where} order by ${order} limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(db),
    sql<{ n: number }>`select count(*)::int as n from admins a where ${where}`.execute(db),
  ])
  const roles = await rolesOf(rows.rows.map((r) => r.id))
  const count = total.rows[0]!.n
  return {
    data: rows.rows.map((r) => ({ id: r.id, email: r.email, fullName: r.full_name, status: r.status, isSuperAdmin: r.is_super_admin, roles: roles.get(r.id) ?? [], lastLoginAt: r.last_login_at?.toISOString() ?? null, createdAt: r.created_at.toISOString() })),
    meta: { page: query.page, pageSize: query.pageSize, total: count, totalPages: Math.max(1, Math.ceil(count / query.pageSize)) },
  }
}

async function loadAdmin(id: string, executor: typeof db | AppTrx = db, lock = false) {
  let q = executor.selectFrom('admins').select(['id', 'email', 'full_name', 'status', 'is_super_admin', 'last_login_at', 'last_login_ip', 'created_at', 'updated_at']).where('id', '=', id).where('deleted_at', 'is', null)
  if (lock) q = q.forUpdate()
  const admin = await q.executeTakeFirst()
  if (!admin) throw notFound('This admin no longer exists.')
  return admin
}

export async function getAdmin(id: string) {
  const admin = await loadAdmin(id)
  const [roles, sessions, invite] = await Promise.all([
    rolesOf([id]),
    db.selectFrom('admin_sessions').select(db.fn.countAll<number>().as('n')).where('admin_id', '=', id).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirstOrThrow(),
    admin.status === 'invited'
      ? db.selectFrom('password_reset_tokens').select('expires_at').where('admin_id', '=', id).where('purpose', '=', 'invite').where('used_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst()
      : Promise.resolve(undefined),
  ])
  return {
    id: admin.id,
    email: admin.email,
    fullName: admin.full_name,
    status: admin.status,
    isSuperAdmin: admin.is_super_admin,
    roles: roles.get(id) ?? [],
    lastLoginAt: admin.last_login_at?.toISOString() ?? null,
    sessionsCount: Number(sessions.n),
    createdAt: admin.created_at.toISOString(),
    updatedAt: admin.updated_at.toISOString(),
    ...(invite ? { inviteExpiresAt: invite.expires_at.toISOString() } : {}),
  }
}

// Roles being assigned: they must exist, only a Super Admin may grant Super Admin, and any sensitive permission they
// carry needs a reason (FR-2.7).
async function resolveRolesToAssign(ctx: Ctx, roleIds: string[], reason: string | undefined, executor: typeof db | AppTrx = db) {
  const roles = await executor.selectFrom('roles').select(['id', 'code', 'name']).where('id', 'in', roleIds).where('deleted_at', 'is', null).execute()
  if (roles.length !== roleIds.length) throw fieldError('roleIds', 'One of those roles no longer exists.')
  if (roles.some((r) => r.code === SUPER_ADMIN_CODE) && !ctx.actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can grant Super Admin.')
  const grantsSuper = roles.some((r) => r.code === SUPER_ADMIN_CODE)
  const sensitive = grantsSuper
    ? ['super_admin']
    : (await executor.selectFrom('role_permissions as rp').innerJoin('permissions as p', 'p.id', 'rp.permission_id').select('p.key').distinct().where('rp.role_id', 'in', roleIds).where('p.is_sensitive', '=', true).execute()).map((r) => r.key)
  requireReasonForSensitive(sensitive, reason)
  return roles
}

const emailTaken = () => new ApiError(409, 'CONFLICT_DUPLICATE', 'An admin with this email already exists.')

async function createInviteToken(trx: AppTrx, adminId: string, ip: string | null) {
  const token = generateOpaqueToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await trx.updateTable('password_reset_tokens').set({ used_at: new Date() }).where('admin_id', '=', adminId).where('purpose', '=', 'invite').where('used_at', 'is', null).execute()
  await trx.insertInto('password_reset_tokens').values({ admin_id: adminId, token_hash: sha256Hex(token), purpose: 'invite', expires_at: expiresAt, requested_ip: ip }).execute()
  return { token, expiresAt }
}

export async function inviteAdmin(ctx: Ctx, body: z.infer<typeof inviteAdminSchema>) {
  const roles = await resolveRolesToAssign(ctx, body.roleIds, body.reason)
  const isSuper = roles.some((r) => r.code === SUPER_ADMIN_CODE)
  const passwordHash = await hashPassword(randomBytes(32).toString('hex')) // unusable until the invite is accepted

  let created: { id: string; token: string; expiresAt: Date }
  try {
    created = await db.transaction().execute(async (trx) => {
      if (await trx.selectFrom('admins').select('id').where('email', '=', body.email).where('deleted_at', 'is', null).executeTakeFirst()) throw emailTaken()
      const admin = await trx
        .insertInto('admins')
        .values({ email: body.email, full_name: body.fullName, password_hash: passwordHash, status: 'invited', is_super_admin: isSuper, created_by: ctx.actor.id, updated_by: ctx.actor.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx.insertInto('admin_roles').values(roles.map((r) => ({ admin_id: admin.id, role_id: r.id, assigned_by: ctx.actor.id }))).execute()
      const invite = await createInviteToken(trx, admin.id, ctx.ip)
      await audit(trx, { ...auditBase(ctx, 'admin', admin.id), action: 'admin.invited', newValues: { email: body.email, roles: roles.map((r) => r.code) }, reason: body.reason ?? null })
      return { id: admin.id, ...invite }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') throw emailTaken()
    throw err
  }
  await sendInviteEmail(body.email, created.token).catch(() => undefined)
  return { id: created.id, email: body.email, status: 'invited' as const, roles: roles.map((r) => ({ code: r.code })), inviteExpiresAt: created.expiresAt.toISOString() }
}

export async function resendInvite(ctx: Ctx, id: string) {
  const { admin, token, expiresAt } = await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    if (admin.status !== 'invited') throw conflictState('Only an invited admin can be sent a new invite.', { currentStatus: admin.status })
    const invite = await createInviteToken(trx, id, ctx.ip)
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.invite_resent' })
    return { admin, ...invite }
  })
  await sendInviteEmail(admin.email, token).catch(() => undefined)
  return { id, email: admin.email, status: 'invited' as const, inviteExpiresAt: expiresAt.toISOString() }
}

export async function patchAdmin(ctx: Ctx, id: string, version: Date | null, fullName: string) {
  await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    if (version && Math.abs(admin.updated_at.getTime() - version.getTime()) >= 1) {
      throw new ApiError(409, 'VERSION_CONFLICT', 'Someone else changed this admin. Reload to see their changes.', { current: await getAdmin(id) })
    }
    if (admin.full_name === fullName) return
    await trx.updateTable('admins').set({ full_name: fullName, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.updated', oldValues: { name: admin.full_name }, newValues: { name: fullName } })
  })
  return getAdmin(id)
}

// The guard rails of FR-2.5 apply to everyone, super admins included.
async function otherActiveSuperAdmins(trx: AppTrx, exceptId: string): Promise<number> {
  const r = await trx.selectFrom('admins').select(db.fn.countAll<number>().as('n')).where('is_super_admin', '=', true).where('status', '=', 'active').where('deleted_at', 'is', null).where('id', '<>', exceptId).executeTakeFirstOrThrow()
  return Number(r.n)
}

async function assertCanLoseSuperAdmin(trx: AppTrx, ctx: Ctx, target: { id: string; is_super_admin: boolean; status: string }, action: string) {
  if (target.id === ctx.actor.id) throw conflictState(`You can't ${action} your own account.`)
  if (target.is_super_admin && target.status === 'active' && (await otherActiveSuperAdmins(trx, target.id)) === 0) throw conflictState(msg.lastSuper)
}

export async function putAdminRoles(ctx: Ctx, id: string, body: { roleIds: string[]; reason?: string }) {
  const result = await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    const next = await resolveRolesToAssign(ctx, body.roleIds, body.reason, trx)
    const current = await trx.selectFrom('admin_roles as ar').innerJoin('roles as r', 'r.id', 'ar.role_id').select(['r.id', 'r.code']).where('ar.admin_id', '=', id).execute()
    const nextIds = new Set(next.map((r) => r.id))
    const added = next.filter((r) => !current.some((c) => c.id === r.id))
    const removed = current.filter((c) => !nextIds.has(c.id))
    const willBeSuper = next.some((r) => r.code === SUPER_ADMIN_CODE)

    if (removed.some((r) => r.code === SUPER_ADMIN_CODE)) {
      if (!ctx.actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can remove Super Admin.')
      await assertCanLoseSuperAdmin(trx, ctx, admin, 'remove Super Admin from')
    }
    if (added.length === 0 && removed.length === 0) return false

    if (removed.length) await trx.deleteFrom('admin_roles').where('admin_id', '=', id).where('role_id', 'in', removed.map((r) => r.id)).execute()
    if (added.length) await trx.insertInto('admin_roles').values(added.map((r) => ({ admin_id: id, role_id: r.id, assigned_by: ctx.actor.id }))).execute()
    await trx.updateTable('admins').set({ is_super_admin: willBeSuper, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.roles_changed', newValues: { added: added.map((r) => r.code), removed: removed.map((r) => r.code) }, reason: body.reason ?? null })
    return true
  })
  if (result) await bustPermissionCache([id])
  return getAdmin(id)
}

export async function disableAdmin(ctx: Ctx, id: string, reason: string) {
  const revoked = await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    if (admin.status === 'disabled') throw conflictState('This admin is already disabled.', { currentStatus: admin.status })
    await assertCanLoseSuperAdmin(trx, ctx, admin, 'disable')
    await trx.updateTable('admins').set({ status: 'disabled', updated_by: ctx.actor.id }).where('id', '=', id).execute()
    const sessions = await trx.updateTable('admin_sessions').set({ revoked_at: new Date(), revoked_reason: 'account_disabled' }).where('admin_id', '=', id).where('revoked_at', 'is', null).returning('id').execute()
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.disabled', newValues: { sessionsRevoked: sessions.length }, reason })
    return sessions.map((s) => s.id)
  })
  await denySessions(revoked)
  await bustPermissionCache([id])
  return getAdmin(id)
}

export async function enableAdmin(ctx: Ctx, id: string) {
  await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    if (admin.status !== 'disabled') throw conflictState('Only a disabled admin can be re-enabled.', { currentStatus: admin.status })
    await trx.updateTable('admins').set({ status: 'active', failed_login_count: 0, locked_until: null, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.enabled' })
  })
  await bustPermissionCache([id])
  return getAdmin(id)
}

export async function deleteAdmin(ctx: Ctx, id: string, reason: string) {
  const revoked = await db.transaction().execute(async (trx) => {
    const admin = await loadAdmin(id, trx, true)
    if (admin.id === ctx.actor.id) throw conflictState("You can't delete your own account.")
    if (admin.status !== 'disabled') throw conflictState('Disable this admin before deleting.', { currentStatus: admin.status })
    await trx.updateTable('admins').set({ deleted_at: new Date(), deleted_by: ctx.actor.id }).where('id', '=', id).execute()
    const sessions = await trx.updateTable('admin_sessions').set({ revoked_at: new Date(), revoked_reason: 'account_disabled' }).where('admin_id', '=', id).where('revoked_at', 'is', null).returning('id').execute()
    await audit(trx, { ...auditBase(ctx, 'admin', id), action: 'admin.deleted', newValues: { sessionsRevoked: sessions.length }, reason })
    return sessions.map((s) => s.id)
  })
  await denySessions(revoked)
  await bustPermissionCache([id])
}

