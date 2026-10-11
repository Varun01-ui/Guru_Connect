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
const EMAIL_PREFIX = 'cat-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)
const ICON_PREFIX = `test-category-icons/${RUN}`

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
const teachers: TestTeacher[] = []
const parents: TestParent[] = []
let originalOrder: { id: string; sort_order: number }[] = []

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'put' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

let seq = 0
type Body = Record<string, unknown>
type CatView = {
  id: string
  name: string
  slug: string
  description: string | null
  iconFileId: string | null
  iconUrl: string | null
  isActive: boolean
  sortOrder: number
  teacherCount: number
  childPreferenceCount: number
  updatedAt: string
  deletedAt: string | null
}
const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  seq += 1
  const res = await send('post', as, '/teacher-categories', { name: `CTest Category ${seq} ${RUN}`, description: 'Test category', isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as CatView
}
const patch = (id: string, body: Body, version: string, as: { token: string } = superAdmin) => send('patch', as, `/teacher-categories/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'teacher_categories').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)

async function makeIcon(overrides: Partial<{ purpose: string; visibility: 'public' | 'private'; status: 'pending' | 'uploaded' | 'quarantined' | 'deleted'; deleted_at: Date | null }> = {}) {
  seq += 1
  const row = await db
    .insertInto('files')
    .values({
      bucket: 'gc-public',
      object_key: `${ICON_PREFIX}/icon-${seq}.png`,
      original_name: 'icon.png',
      mime_type: 'image/png',
      size_bytes: 1024,
      visibility: 'public',
      purpose: 'category_icon',
      uploaded_by_type: 'system',
      status: 'uploaded',
      ...overrides,
    })
    .returning(['id', 'object_key'])
    .executeTakeFirstOrThrow()
  return row
}

// Everything the test admins created, from this and any aborted earlier run: names and slugs are unique, and the
// admin rows cannot be deleted while categories still point at them.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length) {
    const ids = (await db.selectFrom('teacher_categories').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
    if (ids.length) {
      await db.deleteFrom('parent_child_teacher_categories').where('category_id', 'in', ids).execute()
      await db.deleteFrom('teacher_categories').where('id', 'in', ids).execute()
    }
  }
  await db.deleteFrom('files').where('object_key', 'like', 'test-category-icons/%').execute()
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  originalOrder = await db.selectFrom('teacher_categories').select(['id', 'sort_order']).where('deleted_at', 'is', null).where('created_by', 'is', null).execute()
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  // The reorder test rewrites every live category; put the seeded ones back exactly as they were.
  for (const row of originalOrder) await db.updateTable('teacher_categories').set({ sort_order: row.sort_order }).where('id', '=', row.id).execute()
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length) await db.updateTable('teacher_categories').set({ updated_by: null }).where('updated_by', 'in', admins).execute()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describe('permissions (section 13 / 20)', () => {
  it('rejects anonymous callers', async () => {
    expect((await request(app).get(`${API}/teacher-categories`)).status).toBe(401)
  })

  it('lets a read-only admin list but tells them they cannot change anything', async () => {
    const c = await make()
    expect((await get(reader, '/teacher-categories')).status).toBe(200)
    expect((await get(reader, `/teacher-categories/${c.id}`)).status).toBe(200)
    for (const res of [
      await send('post', reader, '/teacher-categories', { name: 'CTest nope' }),
      await patch(c.id, { sortOrder: 51 }, c.updatedAt, reader),
      await send('post', reader, `/teacher-categories/${c.id}/deactivate`, {}),
      await send('delete', reader, `/teacher-categories/${c.id}`),
      await send('put', reader, '/teacher-categories/order', { ids: [c.id] }),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can view teacher categories but not change them.', details: { required: ['education_masters.manage'] } })
    }
  })

  it('blocks admins with no education permission from reading', async () => {
    const res = await get(outsider, '/teacher-categories')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['education_masters.read'] } })
  })

  it('lets an operations admin manage teacher categories', async () => {
    const c = await make({}, ops)
    expect((await patch(c.id, { sortOrder: 51 }, c.updatedAt, ops)).status).toBe(200)
  })
})

describe('create (FR-15.2)', () => {
  it('creates a category, normalises input, generates the slug and audits it', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '/teacher-categories', { name: `  CTest   Sports   Coach ${tag} `, description: '  Cricket, football and fitness coaches ' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: `CTest Sports Coach ${tag}`,
      slug: `ctest-sports-coach-${tag}`,
      description: 'Cricket, football and fitness coaches',
      iconFileId: null,
      iconUrl: null,
      isActive: true,
      sortOrder: 0,
      teacherCount: 0,
      childPreferenceCount: 0,
      deletedAt: null,
    })
    const stored = await db.selectFrom('teacher_categories').select(['created_by', 'updated_by']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ created_by: superAdmin.id, updated_by: superAdmin.id })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'teacher_categories').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'teacher_category.created', actor_id: superAdmin.id, module: 'education_masters' })
    expect(log.new_values).toMatchObject({ slug: `ctest-sports-coach-${tag}` })
  })

  it('gives two categories whose names make the same slug different slugs', async () => {
    const tag = uniqueTag()
    const first = await make({ name: `${tag} C++` })
    const second = await make({ name: `${tag} C--` })
    expect(first.slug).toBe(`${tag}-c`)
    expect(second.slug).toBe(`${tag}-c-2`)
  })

  it('uses a placeholder slug for a name with no letters or digits', async () => {
    const res = await send('post', superAdmin, '/teacher-categories', { name: '!!' })
    expect(res.status).toBe(201)
    expect(res.body.data.slug).toMatch(/^category(-\d+)?$/)
  })

  it('stores a blank description as none and defaults the rest', async () => {
    const res = await send('post', superAdmin, '/teacher-categories', { name: `CTest Defaults ${uniqueTag()}`, description: '  ' })
    expect(res.body.data).toMatchObject({ description: null, isActive: true, sortOrder: 0 })
  })

  it('attaches an uploaded public icon and returns its CDN URL', async () => {
    const icon = await makeIcon()
    const c = await make({ iconFileId: icon.id })
    expect(c.iconFileId).toBe(icon.id)
    expect(c.iconUrl).toContain(icon.object_key)
  })

  it.each([
    ['unknown file', () => ({ iconFileId: randomUUID() })],
    ['a file with another purpose', async () => ({ iconFileId: (await makeIcon({ purpose: 'banner_image' })).id })],
    ['a private file', async () => ({ iconFileId: (await makeIcon({ visibility: 'private' })).id })],
    ['an unfinished upload', async () => ({ iconFileId: (await makeIcon({ status: 'pending' })).id })],
    ['a deleted file', async () => ({ iconFileId: (await makeIcon({ deleted_at: new Date() })).id })],
    ['something that is not an id', () => ({ iconFileId: 'icon.png' })],
  ])('rejects %s as the icon with 422', async (_label, body) => {
    const res = await send('post', superAdmin, '/teacher-categories', { name: `CTest bad icon ${uniqueTag()}`, ...(await body()) })
    expect(res.status).toBe(422)
    expect(res.body.error.details).toContainEqual({ path: 'iconFileId', message: 'Pick an uploaded category icon.' })
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'Name must be 2–50 characters.'],
    ['name too long', { name: 'x'.repeat(51) }, 'name', 'Name must be 2–50 characters.'],
    ['description too long', { description: 'x'.repeat(201) }, 'description', 'Description can be up to 200 characters.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder negative', { sortOrder: -1 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder fractional', { sortOrder: 1.5 }, 'sortOrder', 'Order must be a whole number.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '/teacher-categories', { name: `CTest bad ${uniqueTag()}`, ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('rejects a missing name and fields that are not part of the request (slug, id)', async () => {
    expect((await send('post', superAdmin, '/teacher-categories', {})).status).toBe(422)
    expect((await send('post', superAdmin, '/teacher-categories', { name: `CTest extra ${uniqueTag()}`, slug: 'mine' })).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate name, ignoring case, and writes nothing', async () => {
    const c = await make()
    const res = await send('post', superAdmin, '/teacher-categories', { name: c.name.toUpperCase() })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A teacher category with this name already exists.', details: { field: 'name' } })
  })
})

describe('read (FR-15.1)', () => {
  it('returns one category with teacher and child-preference counts', async () => {
    const c = await make()
    for (let i = 0; i < 2; i++) teachers.push(await createTeacher(masters, { status: 'approved', categoryId: c.id }))
    const parent = await createParent(masters)
    parents.push(parent)
    const child = await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Riya', class_id: masters.classes.five }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('parent_child_teacher_categories').values({ child_id: child.id, category_id: c.id }).execute()

    const res = await get(reader, `/teacher-categories/${c.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, slug: c.slug, teacherCount: 2, childPreferenceCount: 1 })
  })

  it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await get(superAdmin, `/teacher-categories/${id}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Teacher category not found.' })
    }
  })

  it('lists the seeded categories in order, with paging meta', async () => {
    const res = await get(reader, '/teacher-categories?pageSize=100')
    expect(res.status).toBe(200)
    const seededSlugs = ['home-tutor', 'school-teacher', 'coaching-faculty', 'competitive-exam-faculty', 'language-trainer', 'music-arts-teacher', 'coding-skills-mentor']
    // other tests may have added categories of their own; the seeded ones must still appear in their seeded order
    expect(res.body.data.map((c: CatView) => c.slug).filter((slug: string) => seededSlugs.includes(slug))).toEqual(seededSlugs)
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 100 })
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['childPreferenceCount', 'createdAt', 'deletedAt', 'description', 'iconFileId', 'iconUrl', 'id', 'isActive', 'name', 'slug', 'sortOrder', 'teacherCount', 'updatedAt'].sort(),
    )
  })

  it('pages with meta', async () => {
    const tag = uniqueTag()
    for (const n of ['A', 'B', 'C']) await make({ name: `${tag} ${n}` })
    const q = encodeURIComponent(tag)
    expect((await get(reader, `/teacher-categories?q=${q}&pageSize=2`)).body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
    expect((await get(reader, `/teacher-categories?q=${q}&pageSize=2&page=2`)).body.data).toHaveLength(1)
  })

  it('sorts by name and by order, in either direction', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, sortOrder: 61 })
    const b = await make({ name: `${tag} B`, sortOrder: 60 })
    const q = encodeURIComponent(tag)
    const ids = async (sort: string) => (await get(reader, `/teacher-categories?q=${q}&sort=${sort}`)).body.data.map((r: CatView) => r.id)
    expect(await ids('name:asc')).toEqual([a.id, b.id])
    expect(await ids('name:desc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:asc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:desc')).toEqual([a.id, b.id])
  })

  it('searches the name and the slug by prefix, case-insensitively', async () => {
    const tag = uniqueTag()
    const c = await make({ name: `${tag} Studio` })
    for (const term of [tag, tag.toUpperCase(), c.slug.slice(0, 8)]) {
      expect((await get(reader, `/teacher-categories?q=${encodeURIComponent(term)}`)).body.data.map((r: CatView) => r.id), term).toContain(c.id)
    }
  })

  it('treats % and _ in the search term literally', async () => {
    const res = await get(reader, '/teacher-categories?q=%25')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('filters by active state', async () => {
    const tag = uniqueTag()
    const on = await make({ name: `${tag} On`, isActive: true })
    const off = await make({ name: `${tag} Off`, isActive: false })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `/teacher-categories?q=${q}${extra}`)).body.data.map((r: CatView) => r.id).sort()
    expect(await ids('')).toEqual([on.id, off.id].sort())
    expect(await ids('&active=true')).toEqual([on.id])
    expect(await ids('&active=false')).toEqual([off.id])
  })

  it.each([['pageSize=101'], ['pageSize=0'], ['page=0'], ['sort=slug:asc'], ['active=maybe'], ['fields=name,secret']])('rejects ?%s with 422', async (qs) => {
    const res = await get(reader, `/teacher-categories?${qs}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('hides deleted rows, and only a super admin may ask for them', async () => {
    const c = await make()
    expect((await send('delete', superAdmin, `/teacher-categories/${c.id}`)).status).toBe(204)
    const q = encodeURIComponent(c.name)
    expect((await get(reader, `/teacher-categories?q=${q}`)).body.data.map((r: CatView) => r.id)).not.toContain(c.id)
    expect((await get(reader, `/teacher-categories/${c.id}`)).status).toBe(404)
    expect((await get(ops, `/teacher-categories?q=${q}&includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/teacher-categories/${c.id}?includeDeleted=true`)).status).toBe(403)
    const withDeleted = await get(superAdmin, `/teacher-categories?q=${q}&includeDeleted=true`)
    expect(withDeleted.body.data.find((r: CatView) => r.id === c.id).deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/teacher-categories/${c.id}?includeDeleted=true`)).status).toBe(200)
  })
})

describe('dropdown mode (FR-15 S2)', () => {
  it('returns only the requested fields, unpaginated, active rows only', async () => {
    const live = await make({ isActive: true })
    const inactive = await make({ isActive: false })
    const res = await get(reader, '/teacher-categories?active=true&fields=id,name,slug')
    expect(res.status).toBe(200)
    expect(res.body.meta).toBeUndefined()
    expect(res.body.data.find((r: CatView) => r.id === live.id)).toEqual({ id: live.id, name: live.name, slug: live.slug })
    expect(res.body.data.some((r: CatView) => r.id === inactive.id)).toBe(false)
  })

  it('purges the cached list on every write in the module', async () => {
    const url = '/teacher-categories?active=true&fields=id,name'
    const before = await get(reader, url) // warms the cache
    const created = await make()
    const afterCreate = await get(reader, url)
    expect(afterCreate.body.data.some((r: CatView) => r.id === created.id)).toBe(true)
    expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

    await send('post', superAdmin, `/teacher-categories/${created.id}/deactivate`, {})
    expect((await get(reader, url)).body.data.some((r: CatView) => r.id === created.id)).toBe(false)
    await send('post', superAdmin, `/teacher-categories/${created.id}/activate`, {})
    expect((await get(reader, url)).body.data.some((r: CatView) => r.id === created.id)).toBe(true)

    const edited = (await get(reader, `/teacher-categories/${created.id}`)).body.data
    const renamed = `${created.name} Renamed`
    await patch(created.id, { name: renamed }, edited.updatedAt)
    expect((await get(reader, url)).body.data.find((r: CatView) => r.id === created.id).name).toBe(renamed)

    await send('delete', superAdmin, `/teacher-categories/${created.id}`)
    expect((await get(reader, url)).body.data.some((r: CatView) => r.id === created.id)).toBe(false)
  })
})

describe('update (FR-15.3)', () => {
  it('changes only the sent fields, returns the new version and audits the diff', async () => {
    const c = await make({ sortOrder: 50, description: 'Before' })
    const res = await patch(c.id, { sortOrder: 52, description: 'After' }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, name: c.name, sortOrder: 52, description: 'After' })
    expect(res.body.data.updatedAt).not.toBe(c.updatedAt)
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', c.id).where('action', '=', 'teacher_category.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ sortOrder: 50, description: 'Before' })
    expect(log.new_values).toEqual({ sortOrder: 52, description: 'After' })
  })

  it('keeps the slug when the name changes, so links keep working', async () => {
    const c = await make()
    const res = await patch(c.id, { name: `${c.name} Renamed` }, c.updatedAt)
    expect(res.body.data).toMatchObject({ name: `${c.name} Renamed`, slug: c.slug })
  })

  it('sets, replaces and removes the icon', async () => {
    const c = await make()
    const first = await makeIcon()
    const second = await makeIcon()
    const set = await patch(c.id, { iconFileId: first.id }, c.updatedAt)
    expect(set.body.data).toMatchObject({ iconFileId: first.id })
    expect(set.body.data.iconUrl).toContain(first.object_key)
    const replaced = await patch(c.id, { iconFileId: second.id }, set.body.data.updatedAt)
    expect(replaced.body.data.iconUrl).toContain(second.object_key)
    const removed = await patch(c.id, { iconFileId: null }, replaced.body.data.updatedAt)
    expect(removed.body.data).toMatchObject({ iconFileId: null, iconUrl: null })
  })

  it('rejects an icon that is not an uploaded category icon', async () => {
    const c = await make()
    const wrong = await makeIcon({ purpose: 'avatar' })
    const res = await patch(c.id, { iconFileId: wrong.id }, c.updatedAt)
    expect(res.status).toBe(422)
    expect(res.body.error.details).toContainEqual({ path: 'iconFileId', message: 'Pick an uploaded category icon.' })
  })

  it('edits and clears the description', async () => {
    const c = await make({ description: 'Before' })
    const cleared = await patch(c.id, { description: '' }, c.updatedAt)
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.description).toBeNull()
  })

  it('treats an unchanged value as a no-op: same version, no audit row', async () => {
    const c = await make()
    const res = await patch(c.id, { sortOrder: c.sortOrder, description: c.description }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['teacher_category.created'])
  })

  it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
    const c = await make()
    expect((await patch(c.id, { sortOrder: 51 }, c.updatedAt)).status).toBe(200)
    const stale = await patch(c.id, { sortOrder: 52 }, c.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this teacher category. Reload.', details: { current: { id: c.id, sortOrder: 51 } } })
  })

  it('requires an If-Match header', async () => {
    const c = await make()
    const res = await send('patch', superAdmin, `/teacher-categories/${c.id}`, { sortOrder: 51 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an empty body, an invalid value and an unknown field (the slug cannot be edited)', async () => {
    const c = await make()
    expect((await patch(c.id, {}, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { sortOrder: 10000 }, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { slug: 'new-slug' }, c.updatedAt)).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE when renaming onto another category', async () => {
    const a = await make()
    const b = await make()
    const res = await patch(b.id, { name: a.name.toLowerCase() }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })

  it('returns 404 for an unknown or deleted category', async () => {
    const c = await make()
    await send('delete', superAdmin, `/teacher-categories/${c.id}`)
    expect((await patch(c.id, { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch(randomUUID(), { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch('nope', { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const c = await make()
    const [x, y] = await Promise.all([patch(c.id, { sortOrder: 51 }, c.updatedAt), patch(c.id, { sortOrder: 52 }, c.updatedAt)])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })
})

describe('activate / deactivate (FR-15.4)', () => {
  it('toggles the flag, records the reason and keeps the row and its teachers', async () => {
    const c = await make({ isActive: true })
    teachers.push(await createTeacher(masters, { status: 'approved', categoryId: c.id }))
    const off = await send('post', superAdmin, `/teacher-categories/${c.id}/deactivate`, { reason: 'Seasonal' })
    expect(off.status).toBe(200)
    expect(off.body.data).toMatchObject({ isActive: false, teacherCount: 1 }) // FR-15.S2: stays on their profiles
    expect((await send('post', superAdmin, `/teacher-categories/${c.id}/activate`)).body.data.isActive).toBe(true)
    expect(await auditActions(c.id)).toEqual(['teacher_category.created', 'teacher_category.deactivated', 'teacher_category.activated'])
    const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', c.id).where('action', '=', 'teacher_category.deactivated').executeTakeFirstOrThrow()
    expect(log.reason).toBe('Seasonal')
  })

  it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
    const c = await make({ isActive: true })
    const again = await send('post', superAdmin, `/teacher-categories/${c.id}/activate`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['teacher_category.created'])
  })

  it('returns 404 for an unknown category and 422 for an over-long reason', async () => {
    expect((await send('post', superAdmin, `/teacher-categories/${randomUUID()}/activate`, {})).status).toBe(404)
    const c = await make()
    expect((await send('post', superAdmin, `/teacher-categories/${c.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
  })
})

describe('delete (FR-15.5)', () => {
  it('soft-deletes an unused category and frees its name and slug', async () => {
    const c = await make()
    expect((await send('delete', superAdmin, `/teacher-categories/${c.id}`)).status).toBe(204)
    const stored = await db.selectFrom('teacher_categories').select(['deleted_at', 'deleted_by']).where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)
    expect(await auditActions(c.id)).toEqual(['teacher_category.created', 'teacher_category.deleted'])
    const reuse = await send('post', superAdmin, '/teacher-categories', { name: c.name })
    expect(reuse.status).toBe(201)
    expect(reuse.body.data.slug).toBe(c.slug)
    expect((await send('delete', superAdmin, `/teacher-categories/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_IN_USE with reference counts while teachers and children use it', async () => {
    const c = await make()
    teachers.push(await createTeacher(masters, { status: 'approved', categoryId: c.id }))
    const parent = await createParent(masters)
    parents.push(parent)
    const child = await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Aarav', class_id: masters.classes.five }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('parent_child_teacher_categories').values({ child_id: child.id, category_id: c.id }).execute()

    const res = await send('delete', superAdmin, `/teacher-categories/${c.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_IN_USE',
      message: 'This teacher category is in use. Deactivate it instead.',
      details: { references: { teachers: 1, parent_child_teacher_categories: 1 } },
    })
    expect((await get(superAdmin, `/teacher-categories/${c.id}`)).status).toBe(200)
    expect(await auditActions(c.id)).toEqual(['teacher_category.created'])
  })

  it('ignores soft-deleted teachers when checking usage', async () => {
    const c = await make()
    const teacher = await createTeacher(masters, { status: 'approved', categoryId: c.id })
    teachers.push(teacher)
    await db.updateTable('teachers').set({ deleted_at: new Date() }).where('id', '=', teacher.teacherId).execute()
    expect((await send('delete', superAdmin, `/teacher-categories/${c.id}`)).status).toBe(204)
  })

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await send('delete', superAdmin, `/teacher-categories/${randomUUID()}`)).status).toBe(404)
    expect((await send('delete', superAdmin, '/teacher-categories/nope')).status).toBe(404)
  })
})

describe('restore (FR-15.6)', () => {
  it('lets a super admin undelete a category', async () => {
    const c = await make()
    await send('delete', superAdmin, `/teacher-categories/${c.id}`)
    const res = await send('post', superAdmin, `/teacher-categories/${c.id}/restore`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, deletedAt: null, name: c.name })
    expect(await auditActions(c.id)).toEqual(['teacher_category.created', 'teacher_category.deleted', 'teacher_category.restored'])
  })

  it('is refused for an admin who is not a super admin, even with education_masters.manage', async () => {
    const c = await make()
    await send('delete', superAdmin, `/teacher-categories/${c.id}`)
    const res = await send('post', ops, `/teacher-categories/${c.id}/restore`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await get(superAdmin, `/teacher-categories/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_DUPLICATE when the name or slug was taken meanwhile', async () => {
    const c = await make()
    await send('delete', superAdmin, `/teacher-categories/${c.id}`)
    await send('post', superAdmin, '/teacher-categories', { name: c.name })
    const res = await send('post', superAdmin, `/teacher-categories/${c.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
  })

  it('returns 409 CONFLICT_STATE for a category that is not deleted, 404 for an unknown one', async () => {
    const c = await make()
    const live = await send('post', superAdmin, `/teacher-categories/${c.id}/restore`)
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/teacher-categories/${randomUUID()}/restore`)).status).toBe(404)
  })
})

describe('reorder (FR-15.S1)', () => {
  const liveIds = async () => (await db.selectFrom('teacher_categories').select('id').where('deleted_at', 'is', null).orderBy('sort_order').orderBy('id').execute()).map((r) => r.id)
  const orders = async () => Object.fromEntries((await db.selectFrom('teacher_categories').select(['id', 'sort_order']).where('deleted_at', 'is', null).execute()).map((r) => [r.id, r.sort_order]))

  it('rewrites sort_order to 1..n in the given sequence and audits it', async () => {
    await make({ sortOrder: 55 })
    const ids = await liveIds()
    const swapped = [...ids]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]

    const res = await send('put', superAdmin, '/teacher-categories/order', { ids: swapped })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: true })
    const after = await orders()
    swapped.forEach((id, i) => expect(after[id]).toBe(i + 1))
    expect(await auditActions(swapped[0]!)).toContain('teacher_category.reordered')
    const listed = (await get(reader, '/teacher-categories?pageSize=100')).body.data.map((r: CatView) => r.id)
    expect(listed.slice(0, 2)).toEqual([swapped[0], swapped[1]])
  })

  it('is a no-op (and unaudited) when the order is unchanged', async () => {
    const ids = await liveIds()
    const before = (await db.selectFrom('audit_logs').select('id').where('action', '=', 'teacher_category.reordered').execute()).length
    expect((await send('put', superAdmin, '/teacher-categories/order', { ids })).status).toBe(200)
    expect((await db.selectFrom('audit_logs').select('id').where('action', '=', 'teacher_category.reordered').execute()).length).toBe(before)
  })

  it('rejects a list that misses a category, repeats one or names a stranger', async () => {
    const ids = await liveIds()
    for (const bad of [ids.slice(1), [...ids, ids[0]!], [...ids.slice(1), randomUUID()]]) {
      const res = await send('put', superAdmin, '/teacher-categories/order', { ids: bad })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect(await liveIds()).toEqual(ids)
  })

  it('ignores deleted categories and rejects non-uuid or empty bodies', async () => {
    const gone = await make()
    await send('delete', superAdmin, `/teacher-categories/${gone.id}`)
    const ids = await liveIds()
    expect((await send('put', superAdmin, '/teacher-categories/order', { ids: [...ids, gone.id] })).status).toBe(422)
    expect((await send('put', superAdmin, '/teacher-categories/order', { ids: ['x'] })).status).toBe(422)
    expect((await send('put', superAdmin, '/teacher-categories/order', { ids: [] })).status).toBe(422)
    expect((await send('put', superAdmin, '/teacher-categories/order', {})).status).toBe(422)
  })
})
