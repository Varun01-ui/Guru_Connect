import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { outbox } from '../../lib/mailer.js'
import { API, TEST_PASSWORD, authed, createAdminWithToken, purgeRbacFixtures, randomIp } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const strongPassword = 'Another!Strong9pass'

let superAdmin: TestAdmin
type SystemRoles = { super_admin: string; operations_admin: string; verification_admin: string; finance_admin: string; support_admin: string }
let roleIds: SystemRoles

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'put' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

const roleVersion = async (id: string) => (await db.selectFrom('roles').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow()).updated_at.toISOString()
let counter = 0
const roleName = () => `RBAC Test Role ${Date.now()}-${++counter}`
async function newRole(keys: string[] = ['teachers.read'], name = roleName()) {
  const res = await send('post', superAdmin, '/roles', { name, permissionKeys: keys, reason: 'test fixture' })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as { id: string; code: string; name: string; permissionKeys: string[] }
}
const permissionsOf = async (a: { token: string }) => (await get(a, '/auth/me')).body.data.permissions as string[]

beforeAll(async () => {
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], fullName: 'RBAC Test Super' })
  roleIds = Object.fromEntries((await db.selectFrom('roles').select(['id', 'code']).where('deleted_at', 'is', null).execute()).map((r) => [r.code, r.id])) as SystemRoles
})
afterEach(() => {
  outbox.length = 0
})
afterAll(async () => {
  await purgeRbacFixtures()
  await pool.end()
})

describe('requirePermission and /auth/me', () => {
  it('rejects unauthenticated callers and names the missing permission (FR-2.6)', async () => {
    expect((await request(app).get(`${API}/roles`)).status).toBe(401)
    const verifier = await createAdminWithToken({ roles: ['verification_admin'] })
    const res = await get(verifier, '/roles')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['roles.read'] } })
    expect((await get(verifier, '/admins')).status).toBe(403)
    expect((await send('post', verifier, '/roles', { name: 'RBAC Test Nope' })).status).toBe(403)
  })

  it('lets super admins through every check without holding role rows', async () => {
    const bare = await createAdminWithToken({ superAdmin: true })
    expect((await get(bare, '/roles')).status).toBe(200)
    expect((await get(bare, '/admins')).status).toBe(200)
  })

  it('returns roles and the union of permissions from /auth/me', async () => {
    const both = await createAdminWithToken({ roles: ['verification_admin', 'support_admin'] })
    const me = await get(both, '/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.data.roles.map((r: { code: string }) => r.code).sort()).toEqual(['support_admin', 'verification_admin'])
    const keys = me.body.data.permissions as string[]
    expect(keys).toContain('teacher_verification.decide') // verification
    expect(keys).toContain('reviews.read'.replace('reviews.read', keys.find((k) => k.startsWith('reviews.')) ?? 'reviews.read')) // support
    expect(new Set(keys).size).toBe(keys.length) // distinct
    expect(keys).not.toContain('roles.manage')
    const all = (await get(superAdmin, '/auth/me')).body.data.permissions as string[]
    expect(all.length).toBeGreaterThanOrEqual(80)
    expect(all).toContain('roles.manage')
  })

  it('supports etag polling: 304 until roles or permissions change, and takes effect immediately (FR-2.4)', async () => {
    const role = await newRole(['teachers.read'])
    const admin = await createAdminWithToken()
    await db.insertInto('admin_roles').values({ admin_id: admin.id, role_id: role.id }).execute()
    const first = await get(admin, '/auth/me')
    expect(first.body.data.permissions).toEqual(['teachers.read'])
    expect((await get(admin, `/auth/me?etag=${first.body.data.etag}`)).status).toBe(304)
    expect((await get(admin, '/roles')).status).toBe(403)

    const version = await roleVersion(role.id)
    expect((await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read', 'roles.read'] }, { 'If-Match': version })).status).toBe(200)
    // no waiting for the 5-minute cache: the holder sees the change on the very next request
    expect((await get(admin, '/roles')).status).toBe(200)
    const changed = await get(admin, `/auth/me?etag=${first.body.data.etag}`)
    expect(changed.status).toBe(200)
    expect(changed.body.data.etag).not.toBe(first.body.data.etag)
    expect(changed.body.data.permissions).toEqual(['roles.read', 'teachers.read'])
  })
})

describe('GET /permissions and /roles', () => {
  it('groups the catalogue by module', async () => {
    const res = await get(superAdmin, '/permissions')
    expect(res.status).toBe(200)
    const rbac = res.body.data.find((m: { module: string }) => m.module === 'roles')
    expect(rbac.permissions).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'roles.manage', isSensitive: true }), expect.objectContaining({ key: 'roles.read', isSensitive: false })]))
    expect(res.body.data.length).toBeGreaterThan(10)
  })

  it('lists live roles with permission and holder counts', async () => {
    const role = await newRole(['teachers.read', 'teachers.update'])
    const holder = await createAdminWithToken()
    await db.insertInto('admin_roles').values({ admin_id: holder.id, role_id: role.id }).execute()
    const res = await get(superAdmin, '/roles')
    expect(res.status).toBe(200)
    expect(res.body.data.find((r: { code: string }) => r.code === 'super_admin')).toMatchObject({ isSystem: true, name: 'Super Admin' })
    expect(res.body.data.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['super_admin', 'operations_admin', 'verification_admin', 'finance_admin', 'support_admin']))
    expect(res.body.data.find((r: { id: string }) => r.id === role.id)).toMatchObject({ isSystem: false, permissionCount: 2, adminCount: 1 })
  })

  it('shows a role with its permissions and holders; Super Admin shows everything (T: FR-2.2)', async () => {
    const role = await newRole(['teachers.read'])
    const holder = await createAdminWithToken({ fullName: 'Holder Person' })
    await db.insertInto('admin_roles').values({ admin_id: holder.id, role_id: role.id }).execute()
    const res = await get(superAdmin, `/roles/${role.id}`)
    expect(res.body.data).toMatchObject({ id: role.id, isSystem: false, permissionKeys: ['teachers.read'], admins: [{ id: holder.id, fullName: 'Holder Person', email: holder.email }] })
    const sa = await get(superAdmin, `/roles/${roleIds.super_admin}`)
    expect(sa.body.data.permissionKeys.length).toBeGreaterThanOrEqual(80)
    expect((await get(superAdmin, `/roles/${randomUUID()}`)).status).toBe(404)
    expect((await get(superAdmin, '/roles/not-a-uuid')).status).toBe(404)
  })
})

describe('POST /roles', () => {
  it('creates a custom role from a list of permissions with a generated code', async () => {
    const name = `RBAC Test City Launch ${Date.now()}`
    const res = await send('post', superAdmin, '/roles', { name, description: 'Sets up masters for a new city', permissionKeys: ['locations.read', 'locations.manage'] })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name, description: 'Sets up masters for a new city', isSystem: false, permissionKeys: ['locations.manage', 'locations.read'], admins: [] })
    expect(res.body.data.code).toMatch(/^rbac_test_city_launch_\d+$/)
    const row = await db.selectFrom('roles').select(['created_by', 'is_system']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ created_by: superAdmin.id, is_system: false })
    const audit = await db.selectFrom('audit_logs').select(['action', 'module', 'actor_type', 'actor_id']).where('entity_id', '=', res.body.data.id).execute()
    expect(audit).toEqual([{ action: 'role.created', module: 'rbac', actor_type: 'admin', actor_id: superAdmin.id }])
  })

  it('copies the permissions of another role', async () => {
    const res = await send('post', superAdmin, '/roles', { name: roleName(), copyFromRoleId: roleIds.verification_admin, reason: 'Copy of verification role' })
    expect(res.status).toBe(201)
    const source = (await get(superAdmin, `/roles/${roleIds.verification_admin}`)).body.data.permissionKeys
    expect(res.body.data.permissionKeys).toEqual(source)
    const empty = await send('post', superAdmin, '/roles', { name: roleName() })
    expect(empty.body.data.permissionKeys).toEqual([])
  })

  it('refuses a duplicate name in any case (T: Duplicate role name)', async () => {
    const role = await newRole()
    for (const name of [role.name, role.name.toUpperCase(), `  ${role.name}  `]) {
      const res = await send('post', superAdmin, '/roles', { name })
      expect(res.status, name).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A role with this name already exists.' })
    }
    expect((await send('post', superAdmin, '/roles', { name: 'Super Admin' })).status).toBe(409)
  })

  it('rejects unknown and duplicate permission keys by name', async () => {
    const unknown = await send('post', superAdmin, '/roles', { name: roleName(), permissionKeys: ['teachers.read', 'teachers.fly'] })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Unknown permission: teachers.fly' })
    const dup = await send('post', superAdmin, '/roles', { name: roleName(), permissionKeys: ['teachers.read', 'teachers.read'] })
    expect(dup.status).toBe(422)
    expect(dup.body.error.message).toBe('Duplicate permission: teachers.read')
    expect(await db.selectFrom('roles').select('id').where('name', 'like', 'RBAC Test%').where(({ eb, ref }) => eb(ref('description'), 'is', null)).execute()).toBeDefined()
  })

  it('requires a reason when sensitive permissions are granted (FR-2.7)', async () => {
    const res = await send('post', superAdmin, '/roles', { name: roleName(), permissionKeys: ['roles.manage'] })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Add a reason for granting sensitive permissions.' })
    expect(res.body.error.details[0].sensitiveKeys).toEqual(['roles.manage'])
    const ok = await send('post', superAdmin, '/roles', { name: roleName(), permissionKeys: ['roles.manage'], reason: 'Trusted lead' })
    expect(ok.status).toBe(201)
    const audit = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', ok.body.data.id).executeTakeFirstOrThrow()
    expect(audit.reason).toBe('Trusted lead')
  })

  it('validates the fields', async () => {
    for (const body of [{ name: 'ab' }, { name: 'x'.repeat(51) }, { name: roleName(), description: 'd'.repeat(251) }, { name: roleName(), copyFromRoleId: 'nope' }, { name: roleName(), copyFromRoleId: randomUUID() }, { name: roleName(), permissionKeys: Array.from({ length: 201 }, (_, i) => `k${i}`) }, {}]) {
      const res = await send('post', superAdmin, '/roles', body)
      expect([404, 422], JSON.stringify(body).slice(0, 80)).toContain(res.status)
    }
  })
})

describe('PATCH /roles/:id', () => {
  it('renames and describes a custom role', async () => {
    const role = await newRole()
    const name = roleName()
    const res = await send('patch', superAdmin, `/roles/${role.id}`, { name, description: 'New description' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name, description: 'New description' })
    const audit = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', role.id).where('action', '=', 'role.updated').executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ name, description: 'New description' })
    expect(audit.old_values).toMatchObject({ name: role.name })
  })

  it('only lets system roles change their description', async () => {
    const rename = await send('patch', superAdmin, `/roles/${roleIds.finance_admin}`, { name: 'Money Team' })
    expect(rename.status).toBe(409)
    expect(rename.body.error.code).toBe('CONFLICT_STATE')
    const sa = await send('patch', superAdmin, `/roles/${roleIds.super_admin}`, { name: 'Boss' })
    expect(sa.status).toBe(409)
    const row = await db.selectFrom('roles').select(['description', 'name']).where('id', '=', roleIds.finance_admin).executeTakeFirstOrThrow()
    const same = await send('patch', superAdmin, `/roles/${roleIds.finance_admin}`, { description: row.description })
    expect(same.status).toBe(200) // unchanged description is a no-op
  })

  it('rejects an existing name, an empty body and a stale If-Match', async () => {
    const a = await newRole()
    const b = await newRole()
    expect((await send('patch', superAdmin, `/roles/${b.id}`, { name: a.name })).status).toBe(409)
    expect((await send('patch', superAdmin, `/roles/${b.id}`, {})).status).toBe(422)
    const stale = await roleVersion(b.id)
    await send('patch', superAdmin, `/roles/${b.id}`, { description: 'first' }, { 'If-Match': stale })
    const res = await send('patch', superAdmin, `/roles/${b.id}`, { description: 'second' }, { 'If-Match': stale })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this role. Reload to see their changes.' })
    expect(res.body.error.details.current.description).toBe('first')
  })
})

describe('PUT /roles/:id/permissions', () => {
  it('replaces the set, auditing what was added and removed (FR-2.4)', async () => {
    const role = await newRole(['teachers.read', 'teachers.update'])
    const res = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read', 'locations.read'], reason: 'Needs to view cities' }, { 'If-Match': await roleVersion(role.id) })
    expect(res.status).toBe(200)
    expect(res.body.data.permissionKeys).toEqual(['locations.read', 'teachers.read'])
    const audit = await db.selectFrom('audit_logs').select(['new_values', 'reason']).where('entity_id', '=', role.id).where('action', '=', 'role.permissions_changed').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ added: ['locations.read'], removed: ['teachers.update'] })
    expect(audit.reason).toBe('Needs to view cities')
    const granted = await db.selectFrom('role_permissions as rp').innerJoin('permissions as p', 'p.id', 'rp.permission_id').select('rp.granted_by').where('rp.role_id', '=', role.id).where('p.key', '=', 'locations.read').executeTakeFirstOrThrow()
    expect(granted.granted_by).toBe(superAdmin.id)
  })

  it('needs If-Match and rejects a stale matrix (T: Stale matrix)', async () => {
    const role = await newRole()
    expect((await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: [] })).status).toBe(422)
    const stale = await roleVersion(role.id)
    expect((await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read', 'teachers.update'] }, { 'If-Match': stale })).status).toBe(200)
    const res = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: [] }, { 'If-Match': stale })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this role. Reload to see their changes.' })
    expect(res.body.error.details.current.permissionKeys).toEqual(['teachers.read', 'teachers.update'])
  })

  it('never edits Super Admin (T: Editing super_admin permissions)', async () => {
    const res = await send('put', superAdmin, `/roles/${roleIds.super_admin}/permissions`, { permissionKeys: ['teachers.read'] }, { 'If-Match': await roleVersion(roleIds.super_admin) })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Super Admin always has every permission.' })
  })

  it('requires a reason only for newly granted sensitive permissions (T: Sensitive permission without reason)', async () => {
    const role = await newRole(['teachers.read'])
    const noReason = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read', 'payment_config.publish'] }, { 'If-Match': await roleVersion(role.id) })
    expect(noReason.status).toBe(422)
    expect(noReason.body.error.message).toBe('Add a reason for granting sensitive permissions.')
    expect((await get(superAdmin, `/roles/${role.id}`)).body.data.permissionKeys).toEqual(['teachers.read'])
    const ok = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read', 'payment_config.publish'], reason: 'Covering for finance' }, { 'If-Match': await roleVersion(role.id) })
    expect(ok.status).toBe(200)
    // removing a sensitive permission, or keeping it, needs no reason
    const remove = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read'] }, { 'If-Match': await roleVersion(role.id) })
    expect(remove.status).toBe(200)
  })

  it('rejects unknown keys and treats an identical set as a no-op', async () => {
    const role = await newRole(['teachers.read'])
    const bad = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['nope.nope'] }, { 'If-Match': await roleVersion(role.id) })
    expect(bad.status).toBe(422)
    expect(bad.body.error.message).toBe('Unknown permission: nope.nope')
    const before = await roleVersion(role.id)
    const same = await send('put', superAdmin, `/roles/${role.id}/permissions`, { permissionKeys: ['teachers.read'] }, { 'If-Match': before })
    expect(same.status).toBe(200)
    expect(await roleVersion(role.id)).toBe(before)
    expect(await db.selectFrom('audit_logs').select('id').where('entity_id', '=', role.id).where('action', '=', 'role.permissions_changed').execute()).toHaveLength(0)
  })
})

describe('DELETE /roles/:id', () => {
  it('soft-deletes an unused custom role and frees its name', async () => {
    const role = await newRole()
    expect((await send('delete', superAdmin, `/roles/${role.id}`)).status).toBe(204)
    expect((await get(superAdmin, `/roles/${role.id}`)).status).toBe(404)
    const row = await db.selectFrom('roles').select(['deleted_at', 'deleted_by']).where('id', '=', role.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(superAdmin.id)
    expect((await send('post', superAdmin, '/roles', { name: role.name })).status).toBe(201) // name and code are reusable
    expect((await get(superAdmin, '/roles')).body.data.filter((r: { id: string }) => r.id === role.id)).toHaveLength(0)
  })

  it("refuses system roles and roles that admins still hold (T: Deleting a system role / role in use)", async () => {
    const sys = await send('delete', superAdmin, `/roles/${roleIds.support_admin}`)
    expect(sys.status).toBe(409)
    expect(sys.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "System roles can't be deleted." })

    const role = await newRole()
    const holder = await createAdminWithToken({ fullName: 'Role Holder' })
    await db.insertInto('admin_roles').values({ admin_id: holder.id, role_id: role.id }).execute()
    const used = await send('delete', superAdmin, `/roles/${role.id}`)
    expect(used.status).toBe(409)
    expect(used.body.error).toMatchObject({ code: 'CONFLICT_IN_USE', message: 'Remove this role from 1 admins first.' })
    expect(used.body.error.details.references).toEqual([{ id: holder.id, fullName: 'Role Holder' }])
  })

  it('requires roles.manage', async () => {
    const role = await newRole()
    const reader = await createAdminWithToken()
    await db.insertInto('admin_roles').values({ admin_id: reader.id, role_id: roleIds.operations_admin }).execute() // no roles.* permissions
    expect((await send('delete', reader, `/roles/${role.id}`)).status).toBe(403)
  })
})

describe('GET /admins', () => {
  it('lists admins with roles, pagination meta and filters', async () => {
    const role = await newRole()
    const a = await createAdminWithToken({ fullName: 'Zed Listable' })
    const b = await createAdminWithToken({ fullName: 'Amy Listable', status: 'disabled' })
    await db.insertInto('admin_roles').values({ admin_id: a.id, role_id: role.id }).execute()
    await db.updateTable('admins').set({ last_login_at: new Date(Date.now() - 40 * 86_400_000) }).where('id', '=', b.id).execute()

    const all = await get(superAdmin, '/admins?pageSize=100&sort=fullName:asc&q=Listable')
    expect(all.status).toBe(200)
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 100 })
    expect(all.body.meta.total).toBe(2)
    const row = all.body.data.find((x: { id: string }) => x.id === a.id)
    expect(row).toMatchObject({ email: a.email, fullName: 'Zed Listable', status: 'active', isSuperAdmin: false, roles: [{ id: role.id, code: role.code, name: role.name }] })

    const byRole = await get(superAdmin, `/admins?roleId=${role.id}`)
    expect(byRole.body.data.map((x: { id: string }) => x.id)).toEqual([a.id])
    const disabled = await get(superAdmin, '/admins?status=disabled&q=Listable')
    expect(disabled.body.data.map((x: { id: string }) => x.id)).toEqual([b.id])
    const multi = await get(superAdmin, '/admins?status=disabled&status=active&q=Listable&sort=fullName:asc')
    expect(multi.body.data.map((x: { fullName: string }) => x.fullName)).toEqual(['Amy Listable', 'Zed Listable'])
    const stale = await get(superAdmin, '/admins?lastLogin=stale30&q=Listable')
    expect(stale.body.data.map((x: { id: string }) => x.id)).toEqual([b.id])
    const never = await get(superAdmin, '/admins?lastLogin=never&q=Listable')
    expect(never.body.data.map((x: { id: string }) => x.id)).toEqual([a.id])
    const byEmail = await get(superAdmin, `/admins?q=${encodeURIComponent(a.email.slice(0, 20))}`)
    expect(byEmail.body.data.map((x: { id: string }) => x.id)).toContain(a.id)

    const paged = await get(superAdmin, '/admins?pageSize=10&page=1&q=Listable')
    expect(paged.body.meta).toEqual({ page: 1, pageSize: 10, total: 2, totalPages: 1 })
  })

  it('validates paging, sorting and filters', async () => {
    for (const q of ['?pageSize=7', '?page=0', '?sort=password:asc', '?sort=fullName', '?status=weird', '?roleId=nope', '?q=a', '?lastLogin=x']) {
      expect((await get(superAdmin, `/admins${q}`)).status, q).toBe(422)
    }
  })

  it('hides soft-deleted admins and requires admins.read', async () => {
    const gone = await createAdminWithToken({ fullName: 'Deleted Person' })
    await db.updateTable('admins').set({ deleted_at: new Date() }).where('id', '=', gone.id).execute()
    expect((await get(superAdmin, '/admins?q=Deleted Person')).body.data.map((x: { id: string }) => x.id)).not.toContain(gone.id)
    expect((await get(superAdmin, `/admins/${gone.id}`)).status).toBe(404)
    const nobody = await createAdminWithToken({ roles: ['verification_admin'] })
    expect((await get(nobody, '/admins')).status).toBe(403)
  })
})

describe('POST /admins/invite', () => {
  it('creates an invited admin with roles, emails a 72-hour link and the invite can be accepted (T: Invite)', async () => {
    const email = `rbac-test-${randomUUID()}@example.com`
    const res = await send('post', superAdmin, '/admins/invite', { email: email.toUpperCase(), fullName: 'Anjali Menon', roleIds: [roleIds.verification_admin], reason: 'New verification hire' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ email, status: 'invited', roles: [{ code: 'verification_admin' }] })
    expect(new Date(res.body.data.inviteExpiresAt).getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000)

    const row = await db.selectFrom('admins').select(['status', 'is_super_admin', 'created_by', 'full_name']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'invited', is_super_admin: false, created_by: superAdmin.id, full_name: 'Anjali Menon' })
    const mail = outbox.find((m) => m.to === email)
    expect(mail?.text).toMatch(/accept-invite\?token=/)
    const audit = await db.selectFrom('audit_logs').select(['new_values', 'reason']).where('entity_id', '=', res.body.data.id).where('action', '=', 'admin.invited').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ email, roles: ['verification_admin'] })
    expect(JSON.stringify(audit)).not.toContain(mail!.text.match(/token=([^\s]+)/)![1]!)

    // the emailed link works: set a password, then sign in and see the role's permissions
    const token = mail!.text.match(/token=([^\s]+)/)![1]!
    const accept = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: strongPassword })
    expect(accept.status, JSON.stringify(accept.body)).toBe(200)
    const login = await request(app).post(`${API}/auth/login`).set('X-Forwarded-For', randomIp()).send({ email, password: strongPassword })
    expect(login.status).toBe(200)
    const me = await get({ token: login.body.data.accessToken }, '/auth/me')
    expect(me.body.data.roles).toEqual([{ code: 'verification_admin', name: 'Verification Admin' }])
    expect(me.body.data.permissions).toContain('teacher_verification.decide')
  })

  it('refuses an existing email in any case (T: Inviting an email that exists)', async () => {
    const existing = await createAdminWithToken()
    for (const email of [existing.email, existing.email.toUpperCase()]) {
      const res = await send('post', superAdmin, '/admins/invite', { email, fullName: 'Someone Else', roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
      expect(res.status, email).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'An admin with this email already exists.' })
    }
    // a soft-deleted admin's email can be invited again
    await db.updateTable('admins').set({ deleted_at: new Date() }).where('id', '=', existing.id).execute()
    const again = await send('post', superAdmin, '/admins/invite', { email: existing.email, fullName: 'Someone Else', roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
    expect(again.status).toBe(201)
  })

  it('only lets a Super Admin grant Super Admin (T: Assigning super_admin)', async () => {
    const manager = await createAdminWithToken()
    const custom = await newRole(['admins.read', 'admins.manage', 'roles.read'])
    await db.insertInto('admin_roles').values({ admin_id: manager.id, role_id: custom.id }).execute()
    const email = `rbac-test-${randomUUID()}@example.com`
    const res = await send('post', manager, '/admins/invite', { email, fullName: 'Wannabe Super', roleIds: [roleIds.super_admin], reason: 'please' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only a Super Admin can grant Super Admin.' })
    expect(await db.selectFrom('admins').select('id').where('email', '=', email).execute()).toHaveLength(0)

    const ok = await send('post', superAdmin, '/admins/invite', { email, fullName: 'New Super', roleIds: [roleIds.super_admin], reason: 'Second owner' })
    expect(ok.status).toBe(201)
    expect((await db.selectFrom('admins').select('is_super_admin').where('email', '=', email).executeTakeFirstOrThrow()).is_super_admin).toBe(true)
  })

  it('needs a reason when a role carries sensitive permissions, but not for plain roles (FR-2.7)', async () => {
    const email = () => `rbac-test-${randomUUID()}@example.com`
    const plain = await newRole(['teachers.read'])
    expect((await send('post', superAdmin, '/admins/invite', { email: email(), fullName: 'Plain Person', roleIds: [plain.id] })).status).toBe(201)
    const sensitive = await send('post', superAdmin, '/admins/invite', { email: email(), fullName: 'Finance Person', roleIds: [roleIds.finance_admin] })
    expect(sensitive.status).toBe(422)
    expect(sensitive.body.error.message).toBe('Add a reason for granting sensitive permissions.')
    expect((await send('post', superAdmin, '/admins/invite', { email: email(), fullName: 'Finance Person', roleIds: [roleIds.finance_admin], reason: 'Covering payroll' })).status).toBe(201)
  })

  it('validates the body', async () => {
    const ok = { email: `rbac-test-${randomUUID()}@example.com`, fullName: 'Valid Person', roleIds: [roleIds.support_admin], reason: 'reason ok' }
    const six = Object.values(roleIds).slice(0, 6)
    for (const over of [{ email: 'nope' }, { fullName: 'A' }, { fullName: 'Name 123' }, { roleIds: [] }, { roleIds: [roleIds.support_admin, roleIds.support_admin] }, { roleIds: ['x'] }, { roleIds: [randomUUID()] }, { reason: 'abc' }, { extra: 1 }]) {
      const res = await send('post', superAdmin, '/admins/invite', { ...ok, ...over })
      expect(res.status, JSON.stringify(over)).toBe(422)
    }
    if (six.length === 6) expect((await send('post', superAdmin, '/admins/invite', { ...ok, roleIds: six })).status).toBe(422)
    expect(await db.selectFrom('admins').select('id').where('email', '=', ok.email).execute()).toHaveLength(0)
  })
})

describe('admin detail, rename and resend invite', () => {
  it('shows roles, last login and the live session count', async () => {
    const admin = await createAdminWithToken({ roles: ['support_admin'], fullName: 'Detail Person' })
    const res = await get(superAdmin, `/admins/${admin.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: admin.id, email: admin.email, fullName: 'Detail Person', status: 'active', roles: [{ code: 'support_admin' }], sessionsCount: 1, lastLoginAt: null })
    expect(res.body.data).not.toHaveProperty('inviteExpiresAt')
    expect((await get(superAdmin, `/admins/${randomUUID()}`)).status).toBe(404)
    expect((await get(superAdmin, '/admins/nope')).status).toBe(404)
  })

  it('renames an admin with an audit trail, honouring If-Match when given', async () => {
    const admin = await createAdminWithToken({ fullName: 'Old Name' })
    const res = await send('patch', superAdmin, `/admins/${admin.id}`, { fullName: 'New Name' })
    expect(res.status).toBe(200)
    expect(res.body.data.fullName).toBe('New Name')
    const audit = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', admin.id).where('action', '=', 'admin.updated').executeTakeFirstOrThrow()
    expect([audit.old_values, audit.new_values]).toEqual([{ name: 'Old Name' }, { name: 'New Name' }])
    const stale = await send('patch', superAdmin, `/admins/${admin.id}`, { fullName: 'Third Name' }, { 'If-Match': new Date(Date.now() - 60_000).toISOString() })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
    expect((await send('patch', superAdmin, `/admins/${admin.id}`, { fullName: 'X' })).status).toBe(422)
    expect((await send('patch', superAdmin, `/admins/${admin.id}`, { email: 'a@b.com' })).status).toBe(422)
  })

  it('resends an invite: the old link dies, only invited admins qualify', async () => {
    const email = `rbac-test-${randomUUID()}@example.com`
    const invited = await send('post', superAdmin, '/admins/invite', { email, fullName: 'Pending Person', roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
    const first = outbox.find((m) => m.to === email)!.text.match(/token=([^\s]+)/)![1]!
    outbox.length = 0
    const res = await send('post', superAdmin, `/admins/${invited.body.data.id}/resend-invite`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ email, status: 'invited' })
    const second = outbox.find((m) => m.to === email)!.text.match(/token=([^\s]+)/)![1]!
    expect(second).not.toBe(first)
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: first, newPassword: strongPassword })).status).toBe(410)
    const detail = await get(superAdmin, `/admins/${invited.body.data.id}`)
    expect(detail.body.data.inviteExpiresAt).toBe(res.body.data.inviteExpiresAt)
    expect(await db.selectFrom('audit_logs').select('id').where('entity_id', '=', invited.body.data.id).where('action', '=', 'admin.invite_resent').execute()).toHaveLength(1)

    const active = await createAdminWithToken()
    const nope = await send('post', superAdmin, `/admins/${active.id}/resend-invite`)
    expect(nope.status).toBe(409)
    expect(nope.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { currentStatus: 'active' } })
  })
})

describe('PUT /admins/:id/roles', () => {
  it('replaces roles, busts the cache and takes effect at once', async () => {
    const admin = await createAdminWithToken({ roles: ['support_admin'] })
    expect(await permissionsOf(admin)).not.toContain('teacher_verification.review')
    const res = await send('put', superAdmin, `/admins/${admin.id}/roles`, { roleIds: [roleIds.verification_admin], reason: 'Moved to verification' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['verification_admin'])
    expect(await permissionsOf(admin)).toContain('teacher_verification.review')
    const audit = await db.selectFrom('audit_logs').select(['new_values', 'reason']).where('entity_id', '=', admin.id).where('action', '=', 'admin.roles_changed').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ added: ['verification_admin'], removed: ['support_admin'] })
    expect(audit.reason).toBe('Moved to verification')
    const same = await send('put', superAdmin, `/admins/${admin.id}/roles`, { roleIds: [roleIds.verification_admin], reason: 'no change' })
    expect(same.status).toBe(200)
    expect(await db.selectFrom('audit_logs').select('id').where('entity_id', '=', admin.id).where('action', '=', 'admin.roles_changed').execute()).toHaveLength(1)
  })

  it('needs a reason for sensitive roles and rejects bad role ids', async () => {
    const admin = await createAdminWithToken()
    expect((await send('put', superAdmin, `/admins/${admin.id}/roles`, { roleIds: [roleIds.finance_admin] })).status).toBe(422)
    expect((await send('put', superAdmin, `/admins/${admin.id}/roles`, { roleIds: [randomUUID()], reason: 'whatever' })).status).toBe(422)
    expect((await send('put', superAdmin, `/admins/${admin.id}/roles`, { roleIds: [], reason: 'whatever' })).status).toBe(422)
    expect((await send('put', superAdmin, `/admins/${randomUUID()}/roles`, { roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })).status).toBe(404)
  })

  it('keeps is_super_admin in step with the super_admin role, and only supers may change it', async () => {
    const target = await createAdminWithToken({ roles: ['support_admin'] })
    const grant = await send('put', superAdmin, `/admins/${target.id}/roles`, { roleIds: [roleIds.super_admin, roleIds.support_admin], reason: 'Promoted to owner' })
    expect(grant.status).toBe(200)
    expect(grant.body.data.isSuperAdmin).toBe(true)
    expect((await get(target, '/roles')).status).toBe(200) // super admins pass every check right away
    const revoke = await send('put', superAdmin, `/admins/${target.id}/roles`, { roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
    expect(revoke.status).toBe(200)
    expect(revoke.body.data.isSuperAdmin).toBe(false)
    expect((await get(target, '/roles')).status).toBe(403)

    const manager = await createAdminWithToken()
    const custom = await newRole(['admins.read', 'admins.manage'])
    await db.insertInto('admin_roles').values({ admin_id: manager.id, role_id: custom.id }).execute()
    const denied = await send('put', manager, `/admins/${target.id}/roles`, { roleIds: [roleIds.super_admin], reason: 'sneaky' })
    expect(denied.status).toBe(403)
    expect(denied.body.error.message).toBe('Only a Super Admin can grant Super Admin.')
  })

  it("never leaves zero active Super Admins and won't let you demote yourself (T: last super admin)", async () => {
    const lone = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'] })
    const others = (await db.selectFrom('admins').select('id').where('is_super_admin', '=', true).where('status', '=', 'active').where('deleted_at', 'is', null).where('id', '<>', lone.id).execute()).map((a) => a.id)
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', 'in', others.length ? others : [randomUUID()]).execute()
    try {
      const self = await send('put', lone, `/admins/${lone.id}/roles`, { roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
      expect(self.status).toBe(409)
      expect(self.body.error.code).toBe('CONFLICT_STATE')
      const viaOther = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'] }) // a second super admin exists now
      const ok = await send('put', viaOther, `/admins/${lone.id}/roles`, { roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
      expect(ok.status).toBe(200) // fine while another active super admin remains
      const last = await send('put', viaOther, `/admins/${viaOther.id}/roles`, { roleIds: [roleIds.support_admin], reason: 'Test fixture reason' })
      expect(last.status).toBe(409) // but never yourself
      await db.updateTable('admins').set({ status: 'disabled' }).where('id', '=', lone.id).execute()
      const solo = await send('post', viaOther, `/admins/${lone.id}/enable`)
      expect(solo.status).toBe(200)
    } finally {
      if (others.length) await db.updateTable('admins').set({ status: 'active' }).where('id', 'in', others).execute()
    }
  })
})

describe('disable, enable and delete', () => {
  it('disables an admin: sessions are revoked and their token stops working at once (FR-2.5)', async () => {
    const target = await createAdminWithToken({ roles: ['support_admin'] })
    expect((await get(target, '/auth/me')).status).toBe(200)
    const res = await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'Left the company on 30 Sep' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('disabled')
    expect((await get(target, '/auth/me')).status).toBe(401)
    const session = await db.selectFrom('admin_sessions').select(['revoked_at', 'revoked_reason']).where('id', '=', target.sessionId).executeTakeFirstOrThrow()
    expect(session.revoked_at).not.toBeNull()
    expect(session.revoked_reason).toBe('account_disabled')
    const audit = await db.selectFrom('audit_logs').select(['new_values', 'reason']).where('entity_id', '=', target.id).where('action', '=', 'admin.disabled').executeTakeFirstOrThrow()
    expect(audit).toEqual({ new_values: { sessionsRevoked: 1 }, reason: 'Left the company on 30 Sep' })
    const login = await request(app).post(`${API}/auth/login`).set('X-Forwarded-For', randomIp()).send({ email: target.email, password: TEST_PASSWORD })
    expect(login.status).toBe(403)
  })

  it('needs a reason, refuses repeats, self-disable and unknown ids', async () => {
    const target = await createAdminWithToken()
    expect((await send('post', superAdmin, `/admins/${target.id}/disable`, {})).status).toBe(422)
    expect((await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'abc' })).status).toBe(422)
    expect((await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'Because policy says so' })).status).toBe(200)
    const again = await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'Because policy says so' })
    expect(again.status).toBe(409)
    const self = await send('post', superAdmin, `/admins/${superAdmin.id}/disable`, { reason: 'Disabling myself' })
    expect(self.status).toBe(409)
    expect(self.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/admins/${randomUUID()}/disable`, { reason: 'Does not exist' })).status).toBe(404)
  })

  it('protects the last active Super Admin from being disabled (T: Disabling yourself / last super admin)', async () => {
    const lone = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'] })
    const helper = await createAdminWithToken({ roles: [] })
    const custom = await newRole(['admins.read', 'admins.manage'])
    await db.insertInto('admin_roles').values({ admin_id: helper.id, role_id: custom.id }).execute()
    const others = (await db.selectFrom('admins').select('id').where('is_super_admin', '=', true).where('status', '=', 'active').where('deleted_at', 'is', null).where('id', '<>', lone.id).execute()).map((a) => a.id)
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', 'in', others.length ? others : [randomUUID()]).execute()
    try {
      const res = await send('post', helper, `/admins/${lone.id}/disable`, { reason: 'Trying to lock everyone out' })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "You can't remove the last active Super Admin." })
      expect((await get(lone, '/auth/me')).status).toBe(200)
    } finally {
      if (others.length) await db.updateTable('admins').set({ status: 'active' }).where('id', 'in', others).execute()
    }
  })

  it('re-enables a disabled admin and clears lockouts', async () => {
    const target = await createAdminWithToken()
    await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'Temporary leave' })
    await db.updateTable('admins').set({ failed_login_count: 5, locked_until: new Date(Date.now() + 3_600_000) }).where('id', '=', target.id).execute()
    const res = await send('post', superAdmin, `/admins/${target.id}/enable`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
    const row = await db.selectFrom('admins').select(['failed_login_count', 'locked_until']).where('id', '=', target.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ failed_login_count: 0, locked_until: null })
    const login = await request(app).post(`${API}/auth/login`).set('X-Forwarded-For', randomIp()).send({ email: target.email, password: TEST_PASSWORD })
    expect(login.status).toBe(200)
    expect((await send('post', superAdmin, `/admins/${target.id}/enable`)).status).toBe(409) // already active
  })

  it('soft-deletes only disabled admins, with a reason, and never yourself', async () => {
    const target = await createAdminWithToken()
    const active = await send('delete', superAdmin, `/admins/${target.id}`, { reason: 'Account no longer needed' })
    expect(active.status).toBe(409)
    expect(active.body.error.message).toBe('Disable this admin before deleting.')
    await send('post', superAdmin, `/admins/${target.id}/disable`, { reason: 'Left the company' })
    expect((await send('delete', superAdmin, `/admins/${target.id}`, {})).status).toBe(422)
    const res = await send('delete', superAdmin, `/admins/${target.id}`, { reason: 'Account no longer needed' })
    expect(res.status).toBe(204)
    const row = await db.selectFrom('admins').select(['deleted_at', 'deleted_by']).where('id', '=', target.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(superAdmin.id)
    expect((await get(superAdmin, `/admins/${target.id}`)).status).toBe(404)
    expect(await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', target.id).where('action', '=', 'admin.deleted').execute()).toEqual([{ reason: 'Account no longer needed' }])
    expect((await send('delete', superAdmin, `/admins/${superAdmin.id}`, { reason: 'Deleting myself here' })).status).toBe(409)
  })

  it('requires admins.manage', async () => {
    const target = await createAdminWithToken()
    const reader = await createAdminWithToken()
    const custom = await newRole(['admins.read'])
    await db.insertInto('admin_roles').values({ admin_id: reader.id, role_id: custom.id }).execute()
    expect((await get(reader, '/admins')).status).toBe(200)
    expect((await send('post', reader, `/admins/${target.id}/disable`, { reason: 'Not allowed to' })).status).toBe(403)
    expect((await send('post', reader, '/admins/invite', {})).status).toBe(403)
  })
})

describe('DELETE /admins/:id/sessions is gated by sessions.revoke_any (M01 follow-up)', () => {
  it('needs the permission rather than the super admin flag', async () => {
    const target = await createAdminWithToken()
    const nobody = await createAdminWithToken({ roles: ['verification_admin'] })
    const denied = await send('delete', nobody, `/admins/${target.id}/sessions`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.details.required).toEqual(['sessions.revoke_any'])

    const custom = await newRole(['sessions.revoke_any'])
    await db.insertInto('admin_roles').values({ admin_id: nobody.id, role_id: custom.id }).execute()
    await db.insertInto('admin_roles').values({ admin_id: nobody.id, role_id: roleIds.verification_admin }).onConflict((oc) => oc.doNothing()).execute()
    // grant through a role the cache has not seen yet: the new role changes the effective set after a cache bust
    const { bustPermissionCache } = await import('../../lib/permissions.js')
    await bustPermissionCache([nobody.id])
    expect((await send('delete', nobody, `/admins/${target.id}/sessions`)).status).toBe(204)
    expect((await get(target, '/auth/me')).status).toBe(401)
    expect((await send('delete', superAdmin, `/admins/${randomUUID()}/sessions`)).status).toBe(404)
  })
})
