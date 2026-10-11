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
const EMAIL_PREFIX = 'tm-test'
// Codes are letters and underscores only, so the run id and counter are spelled in letters.
const letters = (n: number) => [...n.toString(26)].map((d) => String.fromCharCode(65 + parseInt(d, 26))).join('')
const RUN = letters(Math.floor(Math.random() * 26 ** 5) + 26 ** 4)
const SYSTEM_CODES = ['ONLINE', 'OFFLINE', 'HOME_TUITION', 'HYBRID', 'BATCH']

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
const teachers: TestTeacher[] = []
const parents: TestParent[] = []
let originalSeeded: { id: string; description: string | null; sort_order: number }[] = []

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

let seq = 0
type Body = Record<string, unknown>
type ModeView = {
  id: string
  name: string
  code: string
  description: string | null
  requiresLocation: boolean
  isActive: boolean
  sortOrder: number
  isSystem: boolean
  teacherCount: number
  updatedAt: string
  deletedAt: string | null
}
const nextCode = () => `TM_${RUN}_${letters(++seq + 26)}`
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const code = nextCode()
  const res = await send('post', as, '/teaching-modes', { name: `CTest Mode ${code}`, code, description: 'Test mode', requiresLocation: true, isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as ModeView
}
const patch = (id: string, body: Body, version: string, as: { token: string } = superAdmin) => send('patch', as, `/teaching-modes/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'teaching_modes').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`
const seeded = async (code: string) => (await get(superAdmin, '/teaching-modes?pageSize=100')).body.data.find((m: ModeView) => m.code === code) as ModeView

// Everything the test admins created, from this and any aborted earlier run: codes and names are unique, and the
// admin rows cannot be deleted while teaching modes still point at them.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const ids = (await db.selectFrom('teaching_modes').select('id').where('created_by', 'in', admins).execute()).map((m) => m.id)
  if (ids.length) {
    await db.deleteFrom('parent_children').where('preferred_mode_id', 'in', ids).execute()
    await db.deleteFrom('teacher_teaching_modes').where('teaching_mode_id', 'in', ids).execute()
    await db.deleteFrom('teaching_modes').where('id', 'in', ids).execute()
  }
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  originalSeeded = await db.selectFrom('teaching_modes').select(['id', 'description', 'sort_order']).where('code', 'in', SYSTEM_CODES).where('deleted_at', 'is', null).execute()
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  // Put the built-in modes back exactly as they were, and release their updated_by stamp on the test admins.
  for (const row of originalSeeded) await db.updateTable('teaching_modes').set({ description: row.description, sort_order: row.sort_order }).where('id', '=', row.id).execute()
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length) await db.updateTable('teaching_modes').set({ updated_by: null }).where('updated_by', 'in', admins).execute()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describe('permissions (section 13 / 20)', () => {
  it('rejects anonymous callers', async () => {
    expect((await request(app).get(`${API}/teaching-modes`)).status).toBe(401)
  })

  it('lets a read-only admin list but tells them they cannot change anything', async () => {
    const m = await make()
    expect((await get(reader, '/teaching-modes')).status).toBe(200)
    expect((await get(reader, `/teaching-modes/${m.id}`)).status).toBe(200)
    for (const res of [
      await send('post', reader, '/teaching-modes', { name: 'CTest nope', code: 'NOPE_CODE' }),
      await patch(m.id, { sortOrder: 51 }, m.updatedAt, reader),
      await send('post', reader, `/teaching-modes/${m.id}/deactivate`, {}),
      await send('delete', reader, `/teaching-modes/${m.id}`),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can view teaching modes but not change them.', details: { required: ['education_masters.manage'] } })
    }
  })

  it('blocks admins with no education permission from reading', async () => {
    const res = await get(outsider, '/teaching-modes')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['education_masters.read'] } })
  })

  it('lets an operations admin manage teaching modes', async () => {
    const m = await make({}, ops)
    expect((await patch(m.id, { sortOrder: 51 }, m.updatedAt, ops)).status).toBe(200)
  })
})

describe('create (FR-14.2)', () => {
  it('creates a mode, normalises input and audits it', async () => {
    const code = nextCode()
    const res = await send('post', superAdmin, '/teaching-modes', {
      name: `  CTest   Recorded ${code} `,
      code: code.toLowerCase(),
      description: '  Pre-recorded lessons with weekly doubt calls ',
      requiresLocation: false,
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: `CTest Recorded ${code}`,
      code,
      description: 'Pre-recorded lessons with weekly doubt calls',
      requiresLocation: false,
      isActive: true,
      sortOrder: 0,
      isSystem: false,
      teacherCount: 0,
      deletedAt: null,
    })
    const stored = await db.selectFrom('teaching_modes').select(['created_by', 'updated_by']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ created_by: superAdmin.id, updated_by: superAdmin.id })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'teaching_modes').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'teaching_mode.created', actor_id: superAdmin.id, module: 'education_masters' })
    expect(log.new_values).toMatchObject({ code, requiresLocation: false })
  })

  it('defaults to needing a location, no description, active, order 0', async () => {
    const code = nextCode()
    const res = await send('post', superAdmin, '/teaching-modes', { name: `CTest Defaults ${code}`, code })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ description: null, requiresLocation: true, isActive: true, sortOrder: 0 })
  })

  it('stores a blank description as none', async () => {
    expect((await make({ description: '   ' })).description).toBeNull()
    expect((await make({ description: null })).description).toBeNull()
  })

  it('can be created inactive', async () => {
    expect((await make({ isActive: false })).isActive).toBe(false)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'Name must be 2–40 characters.'],
    ['name too long', { name: 'x'.repeat(41) }, 'name', 'Name must be 2–40 characters.'],
    ['code too short', { code: 'AB' }, 'code', 'Code uses 3–30 capital letters or underscores.'],
    ['code with a digit', { code: 'MODE_2' }, 'code', 'Code uses 3–30 capital letters or underscores.'],
    ['code with a space', { code: 'MY MODE' }, 'code', 'Code uses 3–30 capital letters or underscores.'],
    ['code too long', { code: 'A'.repeat(31) }, 'code', 'Code uses 3–30 capital letters or underscores.'],
    ['description too long', { description: 'x'.repeat(201) }, 'description', 'Description can be up to 200 characters.'],
    ['requiresLocation not a boolean', { requiresLocation: 'yes' }, 'requiresLocation', 'Needs location must be true or false.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder negative', { sortOrder: -1 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder fractional', { sortOrder: 1.5 }, 'sortOrder', 'Order must be a whole number.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '/teaching-modes', { name: `CTest bad ${RUN}`, code: nextCode(), ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('rejects a missing field and an unknown field', async () => {
    expect((await send('post', superAdmin, '/teaching-modes', { name: `CTest half ${RUN}` })).status).toBe(422)
    expect((await send('post', superAdmin, '/teaching-modes', { name: `CTest extra ${RUN}`, code: nextCode(), isSystem: true })).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate name, ignoring case', async () => {
    const m = await make()
    const res = await send('post', superAdmin, '/teaching-modes', { name: m.name.toUpperCase(), code: nextCode() })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A teaching mode with this name already exists.', details: { field: 'name' } })
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate code and writes nothing', async () => {
    const m = await make()
    const res = await send('post', superAdmin, '/teaching-modes', { name: `CTest dup-code ${RUN}`, code: m.code })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A teaching mode with this code already exists.', details: { field: 'code' } })
    expect(await db.selectFrom('teaching_modes').select('id').where('name', '=', `CTest dup-code ${RUN}`).executeTakeFirst()).toBeUndefined()
  })

  it('does not let a new mode borrow a built-in code', async () => {
    const res = await send('post', superAdmin, '/teaching-modes', { name: `CTest Online Clone ${RUN}`, code: 'ONLINE' })
    expect(res.status).toBe(409)
    expect(res.body.error.details).toEqual({ field: 'code' })
  })
})

describe('read (FR-14.1)', () => {
  it('returns one mode with its teacher count', async () => {
    const m = await make()
    for (let i = 0; i < 2; i++) {
      const teacher = await createTeacher(masters, { status: 'approved' })
      teachers.push(teacher)
      await db.insertInto('teacher_teaching_modes').values({ teacher_id: teacher.teacherId, teaching_mode_id: m.id }).execute()
    }
    const res = await get(reader, `/teaching-modes/${m.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: m.id, code: m.code, teacherCount: 2, isSystem: false })
  })

  it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await get(superAdmin, `/teaching-modes/${id}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Teaching mode not found.' })
    }
  })

  it('lists the five built-in modes in order, flagged as system', async () => {
    const res = await get(reader, '/teaching-modes?pageSize=100')
    expect(res.status).toBe(200)
    const builtIn = res.body.data.filter((m: ModeView) => m.isSystem)
    expect(builtIn.map((m: ModeView) => m.code)).toEqual(['ONLINE', 'OFFLINE', 'HOME_TUITION', 'HYBRID', 'BATCH'])
    expect(builtIn.find((m: ModeView) => m.code === 'ONLINE').requiresLocation).toBe(false)
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100 })
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['code', 'createdAt', 'deletedAt', 'description', 'id', 'isActive', 'isSystem', 'name', 'requiresLocation', 'sortOrder', 'teacherCount', 'updatedAt'].sort(),
    )
  })

  it('pages with meta', async () => {
    const tag = uniqueTag()
    for (const n of ['A', 'B', 'C']) await make({ name: `${tag} ${n}` })
    const q = encodeURIComponent(tag)
    expect((await get(reader, `/teaching-modes?q=${q}&pageSize=2`)).body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
    expect((await get(reader, `/teaching-modes?q=${q}&pageSize=2&page=2`)).body.data).toHaveLength(1)
  })

  it('sorts by name and by order, in either direction', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, sortOrder: 61 })
    const b = await make({ name: `${tag} B`, sortOrder: 60 })
    const q = encodeURIComponent(tag)
    const ids = async (sort: string) => (await get(reader, `/teaching-modes?q=${q}&sort=${sort}`)).body.data.map((r: ModeView) => r.id)
    expect(await ids('name:asc')).toEqual([a.id, b.id])
    expect(await ids('name:desc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:asc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:desc')).toEqual([a.id, b.id])
  })

  it('searches the name and the code by prefix, case-insensitively', async () => {
    const m = await make({ name: `${uniqueTag()} Studio` })
    for (const term of [m.name.slice(0, 8), m.name.slice(0, 8).toUpperCase(), m.code.slice(0, 8), m.code.slice(0, 8).toLowerCase()]) {
      const res = await get(reader, `/teaching-modes?q=${encodeURIComponent(term)}`)
      expect(res.body.data.map((r: ModeView) => r.id), term).toContain(m.id)
    }
  })

  it('treats % and _ in the search term literally', async () => {
    const res = await get(reader, '/teaching-modes?q=%25')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('filters by active state', async () => {
    const tag = uniqueTag()
    const on = await make({ name: `${tag} On`, isActive: true })
    const off = await make({ name: `${tag} Off`, isActive: false })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `/teaching-modes?q=${q}${extra}`)).body.data.map((r: ModeView) => r.id).sort()
    expect(await ids('')).toEqual([on.id, off.id].sort())
    expect(await ids('&active=true')).toEqual([on.id])
    expect(await ids('&active=false')).toEqual([off.id])
  })

  it.each([['pageSize=101'], ['pageSize=0'], ['page=0'], ['sort=code:asc'], ['active=maybe'], ['fields=name,secret']])('rejects ?%s with 422', async (qs) => {
    const res = await get(reader, `/teaching-modes?${qs}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('hides deleted rows, and only a super admin may ask for them', async () => {
    const m = await make()
    expect((await send('delete', superAdmin, `/teaching-modes/${m.id}`)).status).toBe(204)
    const q = encodeURIComponent(m.name)
    expect((await get(reader, `/teaching-modes?q=${q}`)).body.data.map((r: ModeView) => r.id)).not.toContain(m.id)
    expect((await get(reader, `/teaching-modes/${m.id}`)).status).toBe(404)
    expect((await get(ops, `/teaching-modes?q=${q}&includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/teaching-modes/${m.id}?includeDeleted=true`)).status).toBe(403)
    const withDeleted = await get(superAdmin, `/teaching-modes?q=${q}&includeDeleted=true`)
    expect(withDeleted.body.data.find((r: ModeView) => r.id === m.id).deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/teaching-modes/${m.id}?includeDeleted=true`)).status).toBe(200)
  })
})

describe('dropdown mode (FR-14 S2)', () => {
  it('returns only the requested fields, unpaginated, active rows only', async () => {
    const live = await make({ isActive: true })
    const inactive = await make({ isActive: false })
    const res = await get(reader, '/teaching-modes?active=true&fields=id,name')
    expect(res.status).toBe(200)
    expect(res.body.meta).toBeUndefined()
    expect(res.body.data.find((r: ModeView) => r.id === live.id)).toEqual({ id: live.id, name: live.name })
    expect(res.body.data.some((r: ModeView) => r.id === inactive.id)).toBe(false)
  })

  it('tells the app whether a mode needs a location', async () => {
    const res = await get(reader, '/teaching-modes?active=true&fields=code,requiresLocation')
    expect(res.body.data).toEqual(expect.arrayContaining([{ code: 'ONLINE', requiresLocation: false }, { code: 'HOME_TUITION', requiresLocation: true }]))
  })

  it('purges the cached list on every write in the module', async () => {
    const url = '/teaching-modes?active=true&fields=id,name'
    const before = await get(reader, url) // warms the cache
    const created = await make()
    const afterCreate = await get(reader, url)
    expect(afterCreate.body.data.some((r: ModeView) => r.id === created.id)).toBe(true)
    expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

    await send('post', superAdmin, `/teaching-modes/${created.id}/deactivate`, {})
    expect((await get(reader, url)).body.data.some((r: ModeView) => r.id === created.id)).toBe(false)
    await send('post', superAdmin, `/teaching-modes/${created.id}/activate`, {})
    expect((await get(reader, url)).body.data.some((r: ModeView) => r.id === created.id)).toBe(true)

    const edited = (await get(reader, `/teaching-modes/${created.id}`)).body.data
    const renamed = `${created.name} Renamed`
    await patch(created.id, { name: renamed }, edited.updatedAt)
    expect((await get(reader, url)).body.data.find((r: ModeView) => r.id === created.id).name).toBe(renamed)

    await send('delete', superAdmin, `/teaching-modes/${created.id}`)
    expect((await get(reader, url)).body.data.some((r: ModeView) => r.id === created.id)).toBe(false)
  })
})

describe('update (FR-14.3)', () => {
  it('changes only the sent fields, returns the new version and audits the diff', async () => {
    const m = await make({ sortOrder: 50, requiresLocation: true })
    const res = await patch(m.id, { sortOrder: 52, requiresLocation: false }, m.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: m.id, name: m.name, sortOrder: 52, requiresLocation: false })
    expect(res.body.data.updatedAt).not.toBe(m.updatedAt)
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', m.id).where('action', '=', 'teaching_mode.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ sortOrder: 50, requiresLocation: true })
    expect(log.new_values).toEqual({ sortOrder: 52, requiresLocation: false })
  })

  it('edits and clears the description', async () => {
    const m = await make({ description: 'Before' })
    const changed = await patch(m.id, { description: ' After ' }, m.updatedAt)
    expect(changed.body.data.description).toBe('After')
    const cleared = await patch(m.id, { description: '' }, changed.body.data.updatedAt)
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.description).toBeNull()
    expect((await patch(m.id, { description: 'x'.repeat(201) }, cleared.body.data.updatedAt)).status).toBe(422)
  })

  it('treats an unchanged value as a no-op: same version, no audit row', async () => {
    const m = await make()
    const res = await patch(m.id, { sortOrder: m.sortOrder, code: m.code, description: m.description }, m.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(m.updatedAt)
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created'])
  })

  it('refuses to change an existing code with 409 CONFLICT_STATE', async () => {
    const m = await make()
    const res = await patch(m.id, { code: nextCode(), name: `${m.name} changed` }, m.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Teaching mode codes can't change." })
    const stored = await db.selectFrom('teaching_modes').select(['code', 'name']).where('id', '=', m.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ code: m.code, name: m.name })
  })

  it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
    const m = await make()
    expect((await patch(m.id, { sortOrder: 51 }, m.updatedAt)).status).toBe(200)
    const stale = await patch(m.id, { sortOrder: 52 }, m.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this teaching mode. Reload.', details: { current: { id: m.id, sortOrder: 51 } } })
  })

  it('requires an If-Match header', async () => {
    const m = await make()
    const res = await send('patch', superAdmin, `/teaching-modes/${m.id}`, { sortOrder: 51 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an empty body, an invalid value and an unknown field', async () => {
    const m = await make()
    expect((await patch(m.id, {}, m.updatedAt)).status).toBe(422)
    expect((await patch(m.id, { sortOrder: 10000 }, m.updatedAt)).status).toBe(422)
    expect((await patch(m.id, { isSystem: true }, m.updatedAt)).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE when renaming onto another mode', async () => {
    const a = await make()
    const b = await make()
    const res = await patch(b.id, { name: a.name.toLowerCase() }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })

  it('returns 404 for an unknown or deleted mode', async () => {
    const m = await make()
    await send('delete', superAdmin, `/teaching-modes/${m.id}`)
    expect((await patch(m.id, { sortOrder: 1 }, m.updatedAt)).status).toBe(404)
    expect((await patch(randomUUID(), { sortOrder: 1 }, m.updatedAt)).status).toBe(404)
    expect((await patch('nope', { sortOrder: 1 }, m.updatedAt)).status).toBe(404)
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const m = await make()
    const [x, y] = await Promise.all([patch(m.id, { sortOrder: 51 }, m.updatedAt), patch(m.id, { sortOrder: 52 }, m.updatedAt)])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })
})

describe('built-in modes (FR-14.S1)', () => {
  it('may change their name, description and order only', async () => {
    const hybrid = await seeded('HYBRID')
    const res = await patch(hybrid.id, { description: 'Mix of online and in-person (edited by a test)' }, hybrid.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ code: 'HYBRID', isSystem: true, description: 'Mix of online and in-person (edited by a test)' })
    // put it back so the next run starts from the seed
    const original = originalSeeded.find((r) => r.id === hybrid.id)!
    await patch(hybrid.id, { description: original.description }, res.body.data.updatedAt)
  })

  it('cannot have the location flag changed', async () => {
    const online = await seeded('ONLINE')
    const res = await patch(online.id, { requiresLocation: true }, online.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Built-in modes can only change their name, description and order.' })
    expect((await seeded('ONLINE')).requiresLocation).toBe(false)
  })

  it('cannot be deactivated, by action or by edit', async () => {
    const batch = await seeded('BATCH')
    const byAction = await send('post', superAdmin, `/teaching-modes/${batch.id}/deactivate`, {})
    expect(byAction.status).toBe(409)
    expect(byAction.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Built-in modes can't be removed." })
    const byEdit = await patch(batch.id, { isActive: false }, batch.updatedAt)
    expect(byEdit.status).toBe(409)
    expect(byEdit.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Built-in modes can't be removed." })
    expect((await seeded('BATCH')).isActive).toBe(true)
  })

  it('activating one is harmless', async () => {
    const offline = await seeded('OFFLINE')
    const res = await send('post', superAdmin, `/teaching-modes/${offline.id}/activate`, {})
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(offline.updatedAt)
  })

  it('cannot be deleted, even when nothing uses them', async () => {
    const home = await seeded('HOME_TUITION')
    const res = await send('delete', superAdmin, `/teaching-modes/${home.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Built-in modes can't be removed." })
    expect((await get(superAdmin, `/teaching-modes/${home.id}`)).status).toBe(200)
  })
})

describe('activate / deactivate (FR-14.4)', () => {
  it('toggles the flag, records the reason and keeps the row', async () => {
    const m = await make({ isActive: true })
    const off = await send('post', superAdmin, `/teaching-modes/${m.id}/deactivate`, { reason: 'Pausing the pilot' })
    expect(off.status).toBe(200)
    expect(off.body.data.isActive).toBe(false)
    expect((await send('post', superAdmin, `/teaching-modes/${m.id}/activate`)).body.data.isActive).toBe(true)
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created', 'teaching_mode.deactivated', 'teaching_mode.activated'])
    const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', m.id).where('action', '=', 'teaching_mode.deactivated').executeTakeFirstOrThrow()
    expect(log.reason).toBe('Pausing the pilot')
  })

  it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
    const m = await make({ isActive: true })
    const again = await send('post', superAdmin, `/teaching-modes/${m.id}/activate`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(m.updatedAt)
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created'])
  })

  it('returns 404 for an unknown mode and 422 for an over-long reason', async () => {
    expect((await send('post', superAdmin, `/teaching-modes/${randomUUID()}/activate`, {})).status).toBe(404)
    const m = await make()
    expect((await send('post', superAdmin, `/teaching-modes/${m.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
  })
})

describe('delete (FR-14.5)', () => {
  it('soft-deletes an unused mode and frees its name and code', async () => {
    const m = await make()
    expect((await send('delete', superAdmin, `/teaching-modes/${m.id}`)).status).toBe(204)
    const stored = await db.selectFrom('teaching_modes').select(['deleted_at', 'deleted_by']).where('id', '=', m.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created', 'teaching_mode.deleted'])
    expect((await send('post', superAdmin, '/teaching-modes', { name: m.name, code: m.code })).status).toBe(201)
    expect((await send('delete', superAdmin, `/teaching-modes/${m.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_IN_USE with reference counts while teachers and children use it', async () => {
    const m = await make()
    const teacher = await createTeacher(masters, { status: 'approved' })
    teachers.push(teacher)
    await db.insertInto('teacher_teaching_modes').values({ teacher_id: teacher.teacherId, teaching_mode_id: m.id }).execute()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Aarav', class_id: masters.classes.five, preferred_mode_id: m.id }).execute()

    const res = await send('delete', superAdmin, `/teaching-modes/${m.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_IN_USE',
      message: 'This teaching mode is in use. Deactivate it instead.',
      details: { references: { teacher_teaching_modes: 1, parent_children: 1 } },
    })
    expect((await get(superAdmin, `/teaching-modes/${m.id}`)).status).toBe(200)
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created'])
  })

  it('ignores soft-deleted children when checking usage', async () => {
    const m = await make()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Gone', class_id: masters.classes.five, preferred_mode_id: m.id, deleted_at: new Date() }).execute()
    expect((await send('delete', superAdmin, `/teaching-modes/${m.id}`)).status).toBe(204)
  })

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await send('delete', superAdmin, `/teaching-modes/${randomUUID()}`)).status).toBe(404)
    expect((await send('delete', superAdmin, '/teaching-modes/nope')).status).toBe(404)
  })
})

describe('restore (FR-14.6)', () => {
  it('lets a super admin undelete a mode', async () => {
    const m = await make()
    await send('delete', superAdmin, `/teaching-modes/${m.id}`)
    const res = await send('post', superAdmin, `/teaching-modes/${m.id}/restore`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: m.id, deletedAt: null, name: m.name })
    expect(await auditActions(m.id)).toEqual(['teaching_mode.created', 'teaching_mode.deleted', 'teaching_mode.restored'])
  })

  it('is refused for an admin who is not a super admin, even with education_masters.manage', async () => {
    const m = await make()
    await send('delete', superAdmin, `/teaching-modes/${m.id}`)
    const res = await send('post', ops, `/teaching-modes/${m.id}/restore`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await get(superAdmin, `/teaching-modes/${m.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_DUPLICATE when the unique fields were taken meanwhile', async () => {
    const m = await make()
    await send('delete', superAdmin, `/teaching-modes/${m.id}`)
    await send('post', superAdmin, '/teaching-modes', { name: m.name, code: m.code })
    const res = await send('post', superAdmin, `/teaching-modes/${m.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
  })

  it('returns 409 CONFLICT_STATE for a mode that is not deleted, 404 for an unknown one', async () => {
    const m = await make()
    const live = await send('post', superAdmin, `/teaching-modes/${m.id}/restore`)
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/teaching-modes/${randomUUID()}/restore`)).status).toBe(404)
  })
})
