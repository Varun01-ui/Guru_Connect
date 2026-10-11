import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { createParent, createTeacher, deleteParent, loadMasters, purgeUsersByPhone } from '../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../test/appHelpers.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const EMAIL_PREFIX = 'cls-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()

let superAdmin: TestAdmin
let ops: TestAdmin // education_masters.read + manage, not a super admin
let reader: TestAdmin // verification_admin: read only
let outsider: TestAdmin // finance_admin: no education permissions
let masters: Masters
const teachers: TestTeacher[] = []
const parents: TestParent[] = []
let originalOrder: { id: string; level_order: number }[] = []

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'put' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

let seq = 0
type Body = Record<string, unknown>
type ClassView = { id: string; name: string; code: string; stage: string; levelOrder: number; isActive: boolean; updatedAt: string; teacherCount: number; childCount: number; deletedAt: string | null }
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  seq += 1
  const res = await send('post', as, '/classes', { name: `CTest Class ${seq} ${RUN}`, code: `CT${RUN}_${seq}`, stage: 'competitive', levelOrder: 40, isActive: true, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as ClassView
}
const patch = (id: string, body: Body, version: string, as: { token: string } = superAdmin) => send('patch', as, `/classes/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'classes').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`

// Everything the test admins created, from this and any aborted earlier run: codes and names are unique, and the
// admin rows cannot be deleted while classes still point at them.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const ids = (await db.selectFrom('classes').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
  if (ids.length) {
    await db.deleteFrom('parent_children').where('class_id', 'in', ids).execute()
    await db.deleteFrom('teacher_classes').where('class_id', 'in', ids).execute()
    await db.deleteFrom('classes').where('id', 'in', ids).execute()
  }
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  originalOrder = await db.selectFrom('classes').select(['id', 'level_order']).where('deleted_at', 'is', null).where('created_by', 'is', null).execute()
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  // The reorder test rewrites every live class; put the seeded ones back exactly as they were.
  for (const row of originalOrder) await db.updateTable('classes').set({ level_order: row.level_order }).where('id', '=', row.id).execute()
  // Editing a seeded row stamps updated_by with a test admin, which would block deleting that admin below.
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length) await db.updateTable('classes').set({ updated_by: null }).where('updated_by', 'in', admins).execute()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describe('permissions (section 13 / 20)', () => {
  it('rejects anonymous callers', async () => {
    expect((await request(app).get(`${API}/classes`)).status).toBe(401)
  })

  it('lets a read-only admin list but tells them they cannot change anything', async () => {
    const c = await make()
    expect((await get(reader, '/classes?q=CTest')).status).toBe(200)
    expect((await get(reader, `/classes/${c.id}`)).status).toBe(200)
    for (const res of [
      await send('post', reader, '/classes', { name: 'CTest nope', code: 'NOPE', stage: 'adult', levelOrder: 1 }),
      await patch(c.id, { levelOrder: 41 }, c.updatedAt, reader),
      await send('post', reader, `/classes/${c.id}/deactivate`, {}),
      await send('delete', reader, `/classes/${c.id}`),
      await send('put', reader, '/classes/order', { ids: [c.id] }),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can view classes but not change them.', details: { required: ['education_masters.manage'] } })
    }
  })

  it('blocks admins with no education permission from reading', async () => {
    const res = await get(outsider, '/classes')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['education_masters.read'] } })
  })

  it('lets an operations admin manage classes', async () => {
    const c = await make({}, ops)
    expect((await patch(c.id, { levelOrder: 41 }, c.updatedAt, ops)).status).toBe(200)
  })
})

describe('create (FR-11.2)', () => {
  it('creates a class, normalises input and audits it', async () => {
    seq += 1
    const res = await send('post', superAdmin, '/classes', { name: `  CTest   Droppers ${seq} ${RUN} `, code: `ct${RUN}_d${seq}`.toLowerCase(), stage: 'competitive', levelOrder: 15 })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: `CTest Droppers ${seq} ${RUN}`, code: `CT${RUN}_D${seq}`, stage: 'competitive', levelOrder: 15, isActive: true, teacherCount: 0, childCount: 0, deletedAt: null })

    const stored = await db.selectFrom('classes').select(['created_by', 'updated_by']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ created_by: superAdmin.id, updated_by: superAdmin.id })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'classes').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'class.created', actor_id: superAdmin.id, module: 'education_masters' })
    expect(log.new_values).toMatchObject({ code: `CT${RUN}_D${seq}`, levelOrder: 15 })
  })

  it('can be created inactive', async () => {
    expect((await make({ isActive: false })).isActive).toBe(false)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'Name must be 2–40 characters.'],
    ['name too long', { name: 'x'.repeat(41) }, 'name', 'Name must be 2–40 characters.'],
    ['code too short', { code: 'A' }, 'code', 'Code uses 2–30 capital letters, digits or underscores.'],
    ['code with a space', { code: 'CLASS 11' }, 'code', 'Code uses 2–30 capital letters, digits or underscores.'],
    ['code too long', { code: 'A'.repeat(31) }, 'code', 'Code uses 2–30 capital letters, digits or underscores.'],
    ['unknown stage', { stage: 'kindergarten' }, 'stage', 'Pick a value from the list.'],
    ['level order above 50', { levelOrder: 51 }, 'levelOrder', 'Level order must be 0–50.'],
    ['level order negative', { levelOrder: -1 }, 'levelOrder', 'Level order must be 0–50.'],
    ['level order fractional', { levelOrder: 1.5 }, 'levelOrder', 'Level order must be a whole number.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    seq += 1
    const res = await send('post', superAdmin, '/classes', { name: `CTest bad ${seq} ${RUN}`, code: `CT${RUN}_B${seq}`, stage: 'adult', levelOrder: 40, ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('rejects a missing field and an unknown field', async () => {
    expect((await send('post', superAdmin, '/classes', { name: `CTest half ${RUN}` })).status).toBe(422)
    seq += 1
    expect((await send('post', superAdmin, '/classes', { name: `CTest extra ${seq} ${RUN}`, code: `CT${RUN}_X${seq}`, stage: 'adult', levelOrder: 1, sortOrder: 3 })).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate name, ignoring case', async () => {
    const c = await make()
    seq += 1
    const res = await send('post', superAdmin, '/classes', { name: c.name.toUpperCase(), code: `CT${RUN}_N${seq}`, stage: 'adult', levelOrder: 40 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A class with this name already exists.', details: { field: 'name' } })
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate code and writes nothing', async () => {
    const c = await make()
    const res = await send('post', superAdmin, '/classes', { name: `CTest dup-code ${RUN}`, code: c.code, stage: 'adult', levelOrder: 40 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A class with this code already exists.', details: { field: 'code' } })
    expect(await db.selectFrom('classes').select('id').where('name', '=', `CTest dup-code ${RUN}`).executeTakeFirst()).toBeUndefined()
  })
})

describe('read (FR-11.1)', () => {
  it('returns one class with teacher and child counts', async () => {
    const c = await make()
    const teacher = await createTeacher(masters, { status: 'approved', classIds: [c.id] })
    teachers.push(teacher)
    const other = await createTeacher(masters, { status: 'approved', classIds: [c.id] })
    teachers.push(other)
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Riya', class_id: c.id }).execute()

    const res = await get(reader, `/classes/${c.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, code: c.code, teacherCount: 2, childCount: 1 })
  })

  it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await get(superAdmin, `/classes/${id}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Class not found.' })
    }
  })

  it('lists the seeded classes in level order by default, with paging meta', async () => {
    const res = await get(reader, '/classes?pageSize=100')
    expect(res.status).toBe(200)
    const orders = res.body.data.map((r: ClassView) => r.levelOrder)
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b))
    expect(res.body.data.map((r: ClassView) => r.code)).toEqual(expect.arrayContaining(['CLASS_1', 'CLASS_10', 'UG', 'COMPETITIVE']))
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100 })
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['childCount', 'code', 'createdAt', 'deletedAt', 'id', 'isActive', 'levelOrder', 'name', 'stage', 'teacherCount', 'updatedAt'].sort())
  })

  it('pages with meta', async () => {
    const tag = uniqueTag()
    for (const n of ['A', 'B', 'C']) await make({ name: `${tag} ${n}` })
    const q = encodeURIComponent(tag)
    const first = await get(reader, `/classes?q=${q}&pageSize=2`)
    expect(first.body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
    const second = await get(reader, `/classes?q=${q}&pageSize=2&page=2`)
    expect(second.body.data).toHaveLength(1)
  })

  it('sorts by name and by level order, in either direction', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, levelOrder: 45 })
    const b = await make({ name: `${tag} B`, levelOrder: 44 })
    const q = encodeURIComponent(tag)
    const names = async (sort: string) => (await get(reader, `/classes?q=${q}&sort=${sort}`)).body.data.map((r: ClassView) => r.id)
    expect(await names('name:asc')).toEqual([a.id, b.id])
    expect(await names('name:desc')).toEqual([b.id, a.id])
    expect(await names('levelOrder:asc')).toEqual([b.id, a.id])
    expect(await names('levelOrder:desc')).toEqual([a.id, b.id])
  })

  it('searches the name and the code by prefix, case-insensitively', async () => {
    const tag = uniqueTag()
    const c = await make({ name: `${tag} Foundation`, code: `${tag.toUpperCase()}_F` })
    for (const term of [tag, tag.toUpperCase(), tag.toLowerCase(), `${tag.toUpperCase()}_f`]) {
      const res = await get(reader, `/classes?q=${encodeURIComponent(term)}`)
      expect(res.body.data.map((r: ClassView) => r.id), term).toContain(c.id)
    }
  })

  it('treats % and _ in the search term literally', async () => {
    const res = await get(reader, '/classes?q=%25')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('filters by stage and by active state', async () => {
    const tag = uniqueTag()
    const adultOn = await make({ name: `${tag} On`, stage: 'adult', isActive: true })
    const adultOff = await make({ name: `${tag} Off`, stage: 'adult', isActive: false })
    const pg = await make({ name: `${tag} Pg`, stage: 'postgraduate', isActive: true })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `/classes?q=${q}${extra}`)).body.data.map((r: ClassView) => r.id).sort()
    expect(await ids('')).toEqual([adultOn.id, adultOff.id, pg.id].sort())
    expect(await ids('&stage=adult')).toEqual([adultOn.id, adultOff.id].sort())
    expect(await ids('&stage=postgraduate')).toEqual([pg.id])
    expect(await ids('&active=true')).toEqual([adultOn.id, pg.id].sort())
    expect(await ids('&active=false&stage=adult')).toEqual([adultOff.id])
  })

  it.each([['pageSize=101'], ['pageSize=0'], ['page=0'], ['sort=code:asc'], ['active=maybe'], ['stage=nursery'], ['fields=name,secret']])('rejects ?%s with 422', async (qs) => {
    const res = await get(reader, `/classes?${qs}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('hides deleted rows, and only a super admin may ask for them', async () => {
    const c = await make()
    expect((await send('delete', superAdmin, `/classes/${c.id}`)).status).toBe(204)

    const q = encodeURIComponent(c.name)
    expect((await get(reader, `/classes?q=${q}`)).body.data.map((r: ClassView) => r.id)).not.toContain(c.id)
    expect((await get(reader, `/classes/${c.id}`)).status).toBe(404)
    expect((await get(ops, `/classes?q=${q}&includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/classes/${c.id}?includeDeleted=true`)).status).toBe(403)

    const withDeleted = await get(superAdmin, `/classes?q=${q}&includeDeleted=true`)
    expect(withDeleted.body.data.find((r: ClassView) => r.id === c.id).deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/classes/${c.id}?includeDeleted=true`)).status).toBe(200)
  })
})

describe('dropdown mode (FR-11 S2)', () => {
  it('returns only the requested fields, unpaginated, active rows only', async () => {
    const live = await make({ isActive: true })
    const inactive = await make({ isActive: false })
    const res = await get(reader, '/classes?active=true&fields=id,name')
    expect(res.status).toBe(200)
    expect(res.body.meta).toBeUndefined()
    expect(res.body.data.find((r: ClassView) => r.id === live.id)).toEqual({ id: live.id, name: live.name })
    expect(res.body.data.some((r: ClassView) => r.id === inactive.id)).toBe(false)
  })

  it('supports code, stage and level order for the app forms', async () => {
    const c = await make({ stage: 'adult', levelOrder: 42 })
    const res = await get(reader, '/classes?active=true&fields=id,code,stage,levelOrder')
    expect(res.body.data.find((r: ClassView) => r.id === c.id)).toEqual({ id: c.id, code: c.code, stage: 'adult', levelOrder: 42 })
  })

  it('purges the cached list on every write in the module', async () => {
    const url = '/classes?active=true&fields=id,name'
    const before = await get(reader, url) // warms the cache
    const created = await make()
    const afterCreate = await get(reader, url)
    expect(afterCreate.body.data.some((r: ClassView) => r.id === created.id)).toBe(true)
    expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

    await send('post', superAdmin, `/classes/${created.id}/deactivate`, {})
    expect((await get(reader, url)).body.data.some((r: ClassView) => r.id === created.id)).toBe(false)
    await send('post', superAdmin, `/classes/${created.id}/activate`, {})
    expect((await get(reader, url)).body.data.some((r: ClassView) => r.id === created.id)).toBe(true)

    const edited = (await get(reader, `/classes/${created.id}`)).body.data
    const renamed = `${created.name} Renamed`
    await patch(created.id, { name: renamed }, edited.updatedAt)
    expect((await get(reader, url)).body.data.find((r: ClassView) => r.id === created.id).name).toBe(renamed)

    await send('delete', superAdmin, `/classes/${created.id}`)
    expect((await get(reader, url)).body.data.some((r: ClassView) => r.id === created.id)).toBe(false)
  })
})

describe('update (FR-11.3)', () => {
  it('changes only the sent fields, returns the new version and audits the diff', async () => {
    const c = await make({ levelOrder: 40, stage: 'competitive' })
    const res = await patch(c.id, { levelOrder: 41, stage: 'adult' }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, name: c.name, levelOrder: 41, stage: 'adult' })
    expect(res.body.data.updatedAt).not.toBe(c.updatedAt)

    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', c.id).where('action', '=', 'class.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ levelOrder: 40, stage: 'competitive' })
    expect(log.new_values).toEqual({ levelOrder: 41, stage: 'adult' })
  })

  it('treats an unchanged value as a no-op: same version, no audit row', async () => {
    const c = await make()
    const res = await patch(c.id, { levelOrder: c.levelOrder, code: c.code }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['class.created'])
  })

  it("refuses to change an existing code with 409 CONFLICT_STATE (FR-11.S2)", async () => {
    const c = await make()
    seq += 1
    const res = await patch(c.id, { code: `CT${RUN}_NEW${seq}`, name: `${c.name} changed` }, c.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Class codes can't change." })
    const stored = await db.selectFrom('classes').select(['code', 'name']).where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ code: c.code, name: c.name }) // nothing else was applied either
  })

  it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
    const c = await make()
    expect((await patch(c.id, { levelOrder: 41 }, c.updatedAt)).status).toBe(200)
    const stale = await patch(c.id, { levelOrder: 42 }, c.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this class. Reload.', details: { current: { id: c.id, levelOrder: 41 } } })
  })

  it('requires an If-Match header', async () => {
    const c = await make()
    const res = await send('patch', superAdmin, `/classes/${c.id}`, { levelOrder: 41 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an empty body, an invalid value and an unknown field', async () => {
    const c = await make()
    expect((await patch(c.id, {}, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { stage: 'nursery' }, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { sortOrder: 3 }, c.updatedAt)).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE when renaming onto another class', async () => {
    const a = await make()
    const b = await make()
    const res = await patch(b.id, { name: a.name.toLowerCase() }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })

  it('returns 404 for an unknown or deleted class', async () => {
    const c = await make()
    await send('delete', superAdmin, `/classes/${c.id}`)
    expect((await patch(c.id, { levelOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch(randomUUID(), { levelOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch('nope', { levelOrder: 1 }, c.updatedAt)).status).toBe(404)
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const c = await make()
    const [x, y] = await Promise.all([patch(c.id, { levelOrder: 41 }, c.updatedAt), patch(c.id, { levelOrder: 42 }, c.updatedAt)])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })
})

describe('activate / deactivate (FR-11.4)', () => {
  it('toggles the flag, records the reason and keeps the row', async () => {
    const c = await make({ isActive: true })
    const off = await send('post', superAdmin, `/classes/${c.id}/deactivate`, { reason: 'Merged into Class 10' })
    expect(off.status).toBe(200)
    expect(off.body.data.isActive).toBe(false)
    expect((await send('post', superAdmin, `/classes/${c.id}/activate`)).body.data.isActive).toBe(true)
    expect(await auditActions(c.id)).toEqual(['class.created', 'class.deactivated', 'class.activated'])
    const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', c.id).where('action', '=', 'class.deactivated').executeTakeFirstOrThrow()
    expect(log.reason).toBe('Merged into Class 10')
  })

  it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
    const c = await make({ isActive: true })
    const again = await send('post', superAdmin, `/classes/${c.id}/activate`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['class.created'])
  })

  it('returns 404 for an unknown class and 422 for an over-long reason', async () => {
    expect((await send('post', superAdmin, `/classes/${randomUUID()}/activate`, {})).status).toBe(404)
    const c = await make()
    expect((await send('post', superAdmin, `/classes/${c.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
  })
})

describe('delete (FR-11.5)', () => {
  it('soft-deletes an unused class and frees its name and code', async () => {
    const c = await make()
    expect((await send('delete', superAdmin, `/classes/${c.id}`)).status).toBe(204)
    const stored = await db.selectFrom('classes').select(['deleted_at', 'deleted_by']).where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)
    expect(await auditActions(c.id)).toEqual(['class.created', 'class.deleted'])

    const reuse = await send('post', superAdmin, '/classes', { name: c.name, code: c.code, stage: 'adult', levelOrder: 40 })
    expect(reuse.status).toBe(201)
    expect((await send('delete', superAdmin, `/classes/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_IN_USE with reference counts while teachers and children use it', async () => {
    const c = await make()
    const teacher = await createTeacher(masters, { status: 'approved', classIds: [c.id] })
    teachers.push(teacher)
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Aarav', class_id: c.id }).execute()
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Ira', class_id: c.id }).execute()

    const res = await send('delete', superAdmin, `/classes/${c.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_IN_USE', message: 'This class is in use. Deactivate it instead.', details: { references: { teacher_classes: 1, parent_children: 2 } } })
    expect((await get(superAdmin, `/classes/${c.id}`)).status).toBe(200)
    expect(await auditActions(c.id)).toEqual(['class.created'])
  })

  it('ignores soft-deleted children when checking usage', async () => {
    const c = await make()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Gone', class_id: c.id, deleted_at: new Date() }).execute()
    expect((await send('delete', superAdmin, `/classes/${c.id}`)).status).toBe(204)
  })

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await send('delete', superAdmin, `/classes/${randomUUID()}`)).status).toBe(404)
    expect((await send('delete', superAdmin, '/classes/nope')).status).toBe(404)
  })
})

describe('restore (FR-11.6)', () => {
  it('lets a super admin undelete a class', async () => {
    const c = await make()
    await send('delete', superAdmin, `/classes/${c.id}`)
    const res = await send('post', superAdmin, `/classes/${c.id}/restore`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, deletedAt: null, name: c.name })
    expect(await auditActions(c.id)).toEqual(['class.created', 'class.deleted', 'class.restored'])
  })

  it('is refused for an admin who is not a super admin, even with education_masters.manage', async () => {
    const c = await make()
    await send('delete', superAdmin, `/classes/${c.id}`)
    const res = await send('post', ops, `/classes/${c.id}/restore`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await get(superAdmin, `/classes/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_DUPLICATE when the unique fields were taken meanwhile', async () => {
    const c = await make()
    await send('delete', superAdmin, `/classes/${c.id}`)
    await send('post', superAdmin, '/classes', { name: c.name, code: c.code, stage: 'adult', levelOrder: 40 })
    const res = await send('post', superAdmin, `/classes/${c.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
  })

  it('returns 409 CONFLICT_STATE for a class that is not deleted, 404 for an unknown one', async () => {
    const c = await make()
    const live = await send('post', superAdmin, `/classes/${c.id}/restore`)
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/classes/${randomUUID()}/restore`)).status).toBe(404)
  })
})

describe('reorder (FR-11.S1)', () => {
  const liveIds = async () => (await db.selectFrom('classes').select('id').where('deleted_at', 'is', null).orderBy('level_order').orderBy('id').execute()).map((r) => r.id)
  const levels = async () => Object.fromEntries((await db.selectFrom('classes').select(['id', 'level_order']).where('deleted_at', 'is', null).execute()).map((r) => [r.id, r.level_order]))

  it('rewrites level_order to 1..n in the given sequence and audits it', async () => {
    const extra = await make({ levelOrder: 44 })
    const ids = await liveIds()
    const swapped = [...ids]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]

    const res = await send('put', superAdmin, '/classes/order', { ids: swapped })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: true })
    const after = await levels()
    swapped.forEach((id, i) => expect(after[id]).toBe(i + 1))
    expect(await auditActions(swapped[0]!)).toContain('class.reordered')
    expect(extra.id).toBeTruthy()

    const listed = (await get(reader, '/classes?pageSize=100')).body.data.map((r: ClassView) => r.id)
    expect(listed.slice(0, 2)).toEqual([swapped[0], swapped[1]])
  })

  it('is a no-op (and unaudited) when the order is unchanged', async () => {
    const ids = await liveIds()
    const before = await db.selectFrom('audit_logs').select('id').where('action', '=', 'class.reordered').execute()
    const res = await send('put', superAdmin, '/classes/order', { ids })
    expect(res.status).toBe(200)
    expect((await db.selectFrom('audit_logs').select('id').where('action', '=', 'class.reordered').execute()).length).toBe(before.length)
  })

  it('rejects a list that misses a class, repeats one or names a stranger', async () => {
    const ids = await liveIds()
    for (const bad of [ids.slice(1), [...ids, ids[0]!], [...ids.slice(1), randomUUID()]]) {
      const res = await send('put', superAdmin, '/classes/order', { ids: bad })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect(await liveIds()).toEqual(ids)
  })

  it('ignores deleted classes and rejects non-uuid or empty bodies', async () => {
    const gone = await make()
    await send('delete', superAdmin, `/classes/${gone.id}`)
    const ids = await liveIds()
    expect((await send('put', superAdmin, '/classes/order', { ids: [...ids, gone.id] })).status).toBe(422)
    expect((await send('put', superAdmin, '/classes/order', { ids: ['x'] })).status).toBe(422)
    expect((await send('put', superAdmin, '/classes/order', { ids: [] })).status).toBe(422)
    expect((await send('put', superAdmin, '/classes/order', {})).status).toBe(422)
  })
})
