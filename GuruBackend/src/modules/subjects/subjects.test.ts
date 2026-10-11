import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { createParent, createTeacher, deleteParent, loadMasters, purgeUsersByPhone, randomPhone } from '../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../test/appHelpers.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { describeMasterCommon, uniqueTag } from '../../test/masterSuite.js'
import type { Body, MasterView } from '../../test/masterSuite.js'

const app = createApp()
const EMAIL_PREFIX = 'sub-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)
const ICON_PREFIX = `test-subject-icons/${RUN}`

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
const teachers: TestTeacher[] = []
const parents: TestParent[] = []
const phones: string[] = []

type SubjectView = MasterView & {
  slug: string
  category: string
  parent: { id: string; name: string } | null
  parentSubjectId: string | null
  aliases: string[]
  classRange: { min: number | null; max: number | null }
  minClassOrder: number | null
  maxClassOrder: number | null
  isTrending: boolean
  sortOrder: number
  teacherCount: number
  iconFileId: string | null
  iconUrl: string | null
}

const get = (a: { token: string }, path: string) => request(app).get(`${API}/subjects${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}/subjects${path}`).set(authed(a.token)).set(headers).send(body)
const patch = (id: string, body: Body, version: string) => send('patch', superAdmin, `/${id}`, body, { 'If-Match': version })
const merge = (id: string, body: Body, as: { token: string } = superAdmin) => send('post', as, `/${id}/merge`, body)

let seq = 0
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const res = await send('post', as, '', { name: `CTest Subject ${++seq} ${RUN}`, category: 'academic', isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as SubjectView
}
async function makeIcon(overrides: Partial<{ purpose: string; visibility: 'public' | 'private'; status: 'pending' | 'uploaded'; deleted_at: Date | null }> = {}) {
  return db
    .insertInto('files')
    .values({ bucket: 'gc-public', object_key: `${ICON_PREFIX}/icon-${++seq}.png`, original_name: 'icon.png', mime_type: 'image/png', size_bytes: 1024, visibility: 'public', purpose: 'subject_icon', uploaded_by_type: 'system', status: 'uploaded', ...overrides })
    .returning(['id', 'object_key'])
    .executeTakeFirstOrThrow()
}
const trendingCount = async () => Number((await db.selectFrom('subjects').select(sql<string>`count(*)`.as('n')).where('is_trending', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()).n)
const adminIds = async () => (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)

// Everything the test admins created, from this and any aborted earlier run. Sub-subjects go first (parent FK).
async function purgeFixtures() {
  const admins = await adminIds()
  if (admins.length) {
    const ids = (await db.selectFrom('subjects').select('id').where('created_by', 'in', admins).execute()).map((s) => s.id)
    if (ids.length) {
      await db.deleteFrom('parent_child_subjects').where('subject_id', 'in', ids).execute()
      await db.deleteFrom('teacher_subjects').where('subject_id', 'in', ids).execute()
      await sql`update institute_batches set subject_ids = '{}' where subject_ids && ${ids}::uuid[]`.execute(db)
      await db.deleteFrom('subjects').where('parent_subject_id', 'in', ids).execute()
      await db.deleteFrom('subjects').where('id', 'in', ids).execute()
    }
  }
  await db.deleteFrom('files').where('object_key', 'like', 'test-subject-icons/%').execute()
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
})

// A test that filled the trending slots must not leave them filled for the next one.
afterEach(async () => {
  const admins = await adminIds()
  if (admins.length) await db.updateTable('subjects').set({ is_trending: false }).where('created_by', 'in', admins).where('is_trending', '=', true).execute()
})

afterAll(async () => {
  await purgeUsersByPhone([...teachers.map((t) => t.phone), ...phones])
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describeMasterCommon<SubjectView>({
  app,
  actors: () => ({ superAdmin, ops, reader, outsider }),
  path: '/subjects',
  noun: 'subject',
  plural: 'subjects',
  notFoundMessage: 'Subject not found.',
  readKey: 'education_masters.read',
  manageKey: 'education_masters.manage',
  entityType: 'subjects',
  auditPrefix: 'subject',
  auditModule: 'education_masters',
  make,
  edit: { field: 'sortOrder', first: 51, second: 52 },
  recreate: (s) => ({ name: s.name, category: s.category }),
  duplicate: { message: 'A subject with this name already exists.', field: 'name' },
  badQueries: ['category=astrology', 'parentId=maths', 'classId=ten', 'trending=maybe'],
})

describe('create (FR-12.2)', () => {
  it('creates a subject, normalises input, makes a slug and audits it', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '', {
      name: `  CTest   Vedic Maths ${tag} `,
      category: 'academic',
      aliases: [' Speed  Maths ', 'VEDIC'],
      minClassOrder: 4,
      maxClassOrder: 12,
      isTrending: false,
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: `CTest Vedic Maths ${tag}`,
      slug: `ctest-vedic-maths-${tag}`,
      category: 'academic',
      parent: null,
      aliases: ['speed maths', 'vedic'],
      classRange: { min: 4, max: 12 },
      isTrending: false,
      isActive: true,
      sortOrder: 0,
      teacherCount: 0,
      iconUrl: null,
      deletedAt: null,
    })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'subjects').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'subject.created', actor_id: superAdmin.id, module: 'education_masters' })
    expect(log.new_values).toMatchObject({ aliases: ['speed maths', 'vedic'], minClassOrder: 4, maxClassOrder: 12 })
  })

  it('gives subjects whose names make the same slug different slugs', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} C++` })
    const b = await make({ name: `${tag} C--` })
    expect(a.slug).toBe(`${tag}-c`)
    expect(b.slug).toBe(`${tag}-c-2`)
  })

  it.each(['academic', 'competitive_exam', 'language', 'music_arts', 'coding_skills', 'other'])('accepts the %s category', async (category) => {
    expect((await make({ category })).category).toBe(category)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'Name must be 2–60 characters.'],
    ['name too long', { name: 'x'.repeat(61) }, 'name', 'Name must be 2–60 characters.'],
    ['unknown category', { category: 'astrology' }, 'category', 'Pick a value from the list.'],
    ['alias too short', { aliases: ['a'] }, 'aliases.0', 'Each alias must be 2–40 characters.'],
    ['alias too long', { aliases: ['x'.repeat(41)] }, 'aliases.0', 'Each alias must be 2–40 characters.'],
    ['repeated alias', { aliases: ['maths', 'Maths'] }, 'aliases', 'Each alias can only be listed once.'],
    ['16 aliases', { aliases: Array.from({ length: 16 }, (_, i) => `alias ${i}`) }, 'aliases', 'A subject can have up to 15 aliases.'],
    ['aliases not a list', { aliases: 'maths' }, 'aliases', 'Aliases must be a list.'],
    ['isTrending not a boolean', { isTrending: 'yes' }, 'isTrending', 'Trending must be true or false.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['parent not an id', { parentSubjectId: 'maths' }, 'parentSubjectId', 'Pick an active parent record.'],
    ['icon not an id', { iconFileId: 'icon.png' }, 'iconFileId', 'Pick an uploaded subject icon.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '', { name: `CTest bad ${++seq} ${RUN}`, category: 'academic', ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('accepts exactly 15 aliases', async () => {
    expect((await make({ aliases: Array.from({ length: 15 }, (_, i) => `alias ${i}`) })).aliases).toHaveLength(15)
  })

  it('rejects a missing category and an unknown field such as slug', async () => {
    expect((await send('post', superAdmin, '', { name: `CTest no category ${RUN}` })).status).toBe(422)
    expect((await send('post', superAdmin, '', { name: `CTest slug ${++seq} ${RUN}`, category: 'academic', slug: 'mine' })).status).toBe(422)
  })
})

describe('class range (section 5)', () => {
  it('accepts open-ended bounds and bounds that are real class levels', async () => {
    expect((await make({ minClassOrder: 9 })).classRange).toEqual({ min: 9, max: null })
    expect((await make({ maxClassOrder: 12 })).classRange).toEqual({ min: null, max: 12 })
    expect((await make({ minClassOrder: 1, maxClassOrder: 16 })).classRange).toEqual({ min: 1, max: 16 })
  })

  it('rejects a level that is not a class, and a first class after the last', async () => {
    const unknown = await send('post', superAdmin, '', { name: `CTest range ${++seq} ${RUN}`, category: 'academic', minClassOrder: 99 })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error.details).toContainEqual({ path: 'minClassOrder', message: 'Pick a class level from the list.' })
    const backwards = await send('post', superAdmin, '', { name: `CTest range ${++seq} ${RUN}`, category: 'academic', minClassOrder: 10, maxClassOrder: 4 })
    expect(backwards.status).toBe(422)
    expect(backwards.body.error.details).toContainEqual({ path: 'minClassOrder', message: 'The first class can’t come after the last class.' })
  })

  it('checks the range against the stored bound when only one side changes', async () => {
    const s = await make({ minClassOrder: 5, maxClassOrder: 10 })
    expect((await patch(s.id, { maxClassOrder: 3 }, s.updatedAt)).status).toBe(422)
    expect((await patch(s.id, { minClassOrder: 11 }, s.updatedAt)).status).toBe(422)
    const widened = await patch(s.id, { maxClassOrder: 12 }, s.updatedAt)
    expect(widened.body.data.classRange).toEqual({ min: 5, max: 12 })
    const cleared = await patch(s.id, { minClassOrder: null, maxClassOrder: null }, widened.body.data.updatedAt)
    expect(cleared.body.data.classRange).toEqual({ min: null, max: null })
  })
})

describe('parent subject (section 5)', () => {
  it('puts a subject under a main subject and shows the parent', async () => {
    const main = await make()
    const sub = await make({ parentSubjectId: main.id })
    expect(sub).toMatchObject({ parent: { id: main.id, name: main.name }, parentSubjectId: main.id })
  })

  it('refuses a third level', async () => {
    const main = await make()
    const sub = await make({ parentSubjectId: main.id })
    const res = await send('post', superAdmin, '', { name: `CTest deep ${++seq} ${RUN}`, category: 'academic', parentSubjectId: sub.id })
    expect(res.status).toBe(422)
    expect(res.body.error.details).toContainEqual({ path: 'parentSubjectId', message: 'A subject can have at most two levels: pick a main subject as the parent.' })
  })

  it('refuses to make a subject its own parent, or to hang it under its own sub-subject', async () => {
    const main = await make()
    const sub = await make({ parentSubjectId: main.id })
    for (const body of [{ id: main.id, parent: main.id }, { id: main.id, parent: sub.id }]) {
      const res = await patch(body.id, { parentSubjectId: body.parent }, main.updatedAt)
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'parentSubjectId', message: "A subject can't be its own parent." })
    }
  })

  it('refuses to give a parent of sub-subjects a parent of its own', async () => {
    const main = await make()
    await make({ parentSubjectId: main.id })
    const other = await make()
    const res = await patch(main.id, { parentSubjectId: other.id }, main.updatedAt)
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].message).toContain('has sub-subjects')
  })

  it('moves a sub-subject to another main subject and detaches it with null', async () => {
    const a = await make()
    const b = await make()
    const sub = await make({ parentSubjectId: a.id })
    const moved = await patch(sub.id, { parentSubjectId: b.id }, sub.updatedAt)
    expect(moved.body.data.parent.id).toBe(b.id)
    const detached = await patch(sub.id, { parentSubjectId: null }, moved.body.data.updatedAt)
    expect(detached.body.data).toMatchObject({ parent: null, parentSubjectId: null })
  })

  it('requires the parent to exist, be active and not be deleted (422)', async () => {
    const inactive = await make({ isActive: false })
    const gone = await make()
    await send('delete', superAdmin, `/${gone.id}`)
    for (const parentSubjectId of [randomUUID(), inactive.id, gone.id]) {
      const res = await send('post', superAdmin, '', { name: `CTest orphan ${++seq} ${RUN}`, category: 'academic', parentSubjectId })
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'parentSubjectId', message: 'Pick an active parent record.' })
    }
  })

  it('refuses to bring a sub-subject back under a deleted parent', async () => {
    const main = await make()
    const sub = await make({ parentSubjectId: main.id })
    await send('delete', superAdmin, `/${sub.id}`)
    await send('delete', superAdmin, `/${main.id}`)
    const res = await send('post', superAdmin, `/${sub.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE' })
    expect(res.body.error.message).toContain(`Restore ${main.name} first`)
  })
})

describe('icon (section 5)', () => {
  it('attaches an uploaded public icon, then replaces and removes it', async () => {
    const first = await makeIcon()
    const second = await makeIcon()
    const s = await make({ iconFileId: first.id })
    expect(s.iconUrl).toContain(first.object_key)
    const replaced = await patch(s.id, { iconFileId: second.id }, s.updatedAt)
    expect(replaced.body.data.iconUrl).toContain(second.object_key)
    const removed = await patch(s.id, { iconFileId: null }, replaced.body.data.updatedAt)
    expect(removed.body.data).toMatchObject({ iconFileId: null, iconUrl: null })
  })

  it.each([
    ['an unknown file', () => ({ iconFileId: randomUUID() })],
    ['a file with another purpose', async () => ({ iconFileId: (await makeIcon({ purpose: 'category_icon' })).id })],
    ['a private file', async () => ({ iconFileId: (await makeIcon({ visibility: 'private' })).id })],
    ['an unfinished upload', async () => ({ iconFileId: (await makeIcon({ status: 'pending' })).id })],
    ['a deleted file', async () => ({ iconFileId: (await makeIcon({ deleted_at: new Date() })).id })],
  ])('rejects %s as the icon with 422', async (_label, body) => {
    const res = await send('post', superAdmin, '', { name: `CTest bad icon ${++seq} ${RUN}`, category: 'academic', ...(await body()) })
    expect(res.status).toBe(422)
    expect(res.body.error.details).toContainEqual({ path: 'iconFileId', message: 'Pick an uploaded subject icon.' })
  })
})

describe('trending (FR-12.S2)', () => {
  // Fill every remaining trending slot with fixtures; returns them.
  async function fillTrending() {
    const filled: SubjectView[] = []
    while ((await trendingCount()) < 10) filled.push(await make({ isTrending: true }))
    return filled
  }

  it('allows up to 10 trending subjects and refuses the 11th, listing the current ten', async () => {
    const filled = await fillTrending()
    expect(await trendingCount()).toBe(10)
    const res = await send('post', superAdmin, '', { name: `CTest eleventh ${++seq} ${RUN}`, category: 'academic', isTrending: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Up to 10 subjects can be trending.' })
    expect(res.body.error.details.trending).toHaveLength(10)
    expect(res.body.error.details.trending[0]).toEqual({ id: expect.any(String), name: expect.any(String) })
    expect(filled.length).toBeLessThanOrEqual(10)
    expect(await db.selectFrom('subjects').select('id').where('name', '=', `CTest eleventh ${seq} ${RUN}`).executeTakeFirst()).toBeUndefined()
  })

  it('refuses to turn trending on for another subject when full, but lets a trending one be edited', async () => {
    const [first] = await fillTrending().then((f) => (f.length ? f : [null]))
    const extra = await make()
    const full = await patch(extra.id, { isTrending: true }, extra.updatedAt)
    expect(full.status).toBe(409)
    expect(full.body.error.message).toBe('Up to 10 subjects can be trending.')
    if (first) expect((await patch(first.id, { sortOrder: 7 }, first.updatedAt)).status).toBe(200) // already trending: not a new slot
  })

  it('frees a slot when a trending subject is switched off, deactivated-and-deleted or merged away', async () => {
    const filled = await fillTrending()
    const extra = await make()
    expect((await patch(extra.id, { isTrending: true }, extra.updatedAt)).status).toBe(409)
    const victim = filled[0]!
    expect((await patch(victim.id, { isTrending: false }, victim.updatedAt)).status).toBe(200)
    expect((await patch(extra.id, { isTrending: true }, extra.updatedAt)).status).toBe(200)
    expect(await trendingCount()).toBe(10)
  })

  it('does not count a deleted trending subject, and will not restore it into a full list', async () => {
    const filled = await fillTrending()
    const gone = filled[0]!
    expect((await send('delete', superAdmin, `/${gone.id}`)).status).toBe(204)
    const taker = await make({ isTrending: true }) // takes the freed slot
    expect(taker.isTrending).toBe(true)
    const res = await send('post', superAdmin, `/${gone.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toBe('Up to 10 subjects can be trending.')
  })

  it('lets only one of two simultaneous requests take the last slot', async () => {
    await fillTrending()
    const freed = await make({ isTrending: false })
    const [a, b] = await Promise.all([make({ name: `CTest race A ${RUN}` }), make({ name: `CTest race B ${RUN}` })])
    // make room for exactly one
    const trendingNow = await db.selectFrom('subjects').select(['id', 'updated_at']).where('is_trending', '=', true).where('deleted_at', 'is', null).where('created_by', '=', superAdmin.id).limit(1).executeTakeFirstOrThrow()
    await db.updateTable('subjects').set({ is_trending: false }).where('id', '=', trendingNow.id).execute()
    const outcomes = await Promise.all([patch(a.id, { isTrending: true }, a.updatedAt), patch(b.id, { isTrending: true }, b.updatedAt)])
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await trendingCount()).toBe(10)
    expect(freed.id).toBeTruthy()
  })
})

describe('read (FR-12.1)', () => {
  it('returns the subject with its teacher count', async () => {
    const s = await make()
    teachers.push(await createTeacher(masters, { status: 'approved', subjectIds: [s.id] }))
    teachers.push(await createTeacher(masters, { status: 'approved', subjectIds: [s.id] }))
    const res = await get(reader, `/${s.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: s.id, teacherCount: 2 })
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['aliases', 'category', 'classRange', 'createdAt', 'deletedAt', 'iconFileId', 'iconUrl', 'id', 'isActive', 'isTrending', 'maxClassOrder', 'minClassOrder', 'name', 'parent', 'parentSubjectId', 'slug', 'sortOrder', 'teacherCount', 'updatedAt'].sort(),
    )
  })

  it('lists the seeded subjects with their class range', async () => {
    const res = await get(reader, '?pageSize=100&sort=name:asc')
    expect(res.body.data.find((s: SubjectView) => s.slug === 'physics')).toMatchObject({ category: 'academic', classRange: { min: 9, max: 14 }, isTrending: true })
  })

  it('filters by category, parent, trending and active', async () => {
    const tag = uniqueTag()
    const main = await make({ name: `${tag} Main`, category: 'language' })
    const sub = await make({ name: `${tag} Sub`, category: 'language', parentSubjectId: main.id, isActive: false })
    const other = await make({ name: `${tag} Other`, category: 'music_arts', isTrending: true })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `?q=${q}${extra}`)).body.data.map((r: SubjectView) => r.id).sort()
    expect(await ids('')).toEqual([main.id, sub.id, other.id].sort())
    expect(await ids('&category=language')).toEqual([main.id, sub.id].sort())
    expect(await ids(`&parentId=${main.id}`)).toEqual([sub.id])
    expect(await ids('&trending=true')).toEqual([other.id])
    expect(await ids('&active=false')).toEqual([sub.id])
  })

  it('filters to the subjects offered for a class, treating an empty bound as open-ended (FR-12.S3)', async () => {
    const tag = uniqueTag()
    const closed = await make({ name: `${tag} Closed`, minClassOrder: 9, maxClassOrder: 12 })
    const noMin = await make({ name: `${tag} NoMin`, maxClassOrder: 5 })
    const noMax = await make({ name: `${tag} NoMax`, minClassOrder: 6 })
    const any = await make({ name: `${tag} Any` })
    const q = encodeURIComponent(tag)
    const forClass = async (id: string) => (await get(reader, `?q=${q}&classId=${id}`)).body.data.map((r: SubjectView) => r.id).sort()
    expect(await forClass(masters.classes.five)).toEqual([noMin.id, any.id].sort())
    expect(await forClass(masters.classes.nine)).toEqual([closed.id, noMax.id, any.id].sort())
    expect(await forClass(masters.classes.eleven)).toEqual([closed.id, noMax.id, any.id].sort())
  })

  it('searches the name and any alias', async () => {
    const tag = uniqueTag()
    const s = await make({ name: `${tag} Mathematics`, aliases: [`${tag}maths`, 'number work'] })
    for (const term of [tag, `${tag}MATHS`, 'number', 'Number Work']) {
      expect((await get(reader, `?q=${encodeURIComponent(term)}`)).body.data.map((r: SubjectView) => r.id), term).toContain(s.id)
    }
    expect((await get(reader, '?q=umber')).body.data.map((r: SubjectView) => r.id)).not.toContain(s.id) // prefix, not substring
  })
})

describe('dropdown mode (FR-12 S2)', () => {
  it('filters by class and returns the range for the app', async () => {
    const s = await make({ minClassOrder: 9, maxClassOrder: 12, category: 'competitive_exam', isTrending: true })
    const res = await get(reader, `?active=true&classId=${masters.classes.nine}&fields=id,slug,category,minClassOrder,maxClassOrder,isTrending,parentSubjectId`)
    expect(res.body.data.find((r: SubjectView) => r.id === s.id)).toEqual({ id: s.id, slug: s.slug, category: 'competitive_exam', minClassOrder: 9, maxClassOrder: 12, isTrending: true, parentSubjectId: null })
    const five = await get(reader, `?active=true&classId=${masters.classes.five}&fields=id`)
    expect(five.body.data.some((r: SubjectView) => r.id === s.id)).toBe(false)
  })
})

describe('update (FR-12.3)', () => {
  it('edits aliases and category, auditing the difference', async () => {
    const s = await make({ aliases: ['one', 'two'] })
    const res = await patch(s.id, { aliases: ['two', 'three'], category: 'language' }, s.updatedAt)
    expect(res.body.data).toMatchObject({ aliases: ['two', 'three'], category: 'language' })
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', s.id).where('action', '=', 'subject.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ aliases: ['one', 'two'], category: 'academic' })
    expect(log.new_values).toEqual({ aliases: ['two', 'three'], category: 'language' })
  })

  it('treats the same aliases as no change, but a different order as a change', async () => {
    const s = await make({ aliases: ['one', 'two'] })
    expect((await patch(s.id, { aliases: ['One', ' two '] }, s.updatedAt)).body.data.updatedAt).toBe(s.updatedAt)
    expect((await patch(s.id, { aliases: ['two', 'one'] }, s.updatedAt)).body.data.aliases).toEqual(['two', 'one'])
  })

  it('keeps the slug when the name changes', async () => {
    const s = await make()
    const res = await patch(s.id, { name: `${s.name} Renamed` }, s.updatedAt)
    expect(res.body.data).toMatchObject({ name: `${s.name} Renamed`, slug: s.slug })
  })

  it('does not let the slug be edited', async () => {
    const s = await make()
    expect((await patch(s.id, { slug: 'new-slug' }, s.updatedAt)).status).toBe(422)
  })
})

describe('merge (FR-12.S1)', () => {
  const subjectsOf = async (teacherId: string) => db.selectFrom('teacher_subjects').select(['subject_id', 'is_primary']).where('teacher_id', '=', teacherId).execute()

  it('moves teachers, children and batches to the target, adds the source name as an alias and removes the source', async () => {
    const source = await make({ name: `CTest Maths ${uniqueTag()}`, aliases: ['math'] })
    const target = await make({ name: `CTest Mathematics ${uniqueTag()}`, aliases: [] })
    const teacher = await createTeacher(masters, { status: 'approved', subjectIds: [source.id] })
    teachers.push(teacher)
    const parent = await createParent(masters)
    parents.push(parent)
    const child = await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Riya', class_id: masters.classes.five }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('parent_child_subjects').values({ child_id: child.id, subject_id: source.id }).execute()

    const phone = randomPhone()
    phones.push(phone)
    const institute = await db
      .insertInto('institutes')
      .values({ name: 'Merge Test Institute', slug: `merge-${randomUUID().slice(0, 8)}`, institute_type: 'coaching_centre', phone, address_line: '12 Test Road', city_id: masters.city.id, area_id: masters.areas[0]!.id, pincode: '560034', verification_status: 'approved', account_status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const batch = await sql<{ id: string }>`insert into institute_batches (institute_id, name, subject_ids) values (${institute.id}, 'Batch', ${[source.id, target.id]}::uuid[]) returning id`.execute(db)
    const batchOnlySource = await sql<{ id: string }>`insert into institute_batches (institute_id, name, subject_ids) values (${institute.id}, 'Batch 2', ${[source.id]}::uuid[]) returning id`.execute(db)

    const res = await merge(source.id, { intoSubjectId: target.id, reason: 'Same subject, two spellings' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.aliasAdded).toBe(true)
    expect(res.body.data.subject).toMatchObject({ id: target.id, aliases: [source.name.toLowerCase()], teacherCount: 1 })
    expect(res.body.data.moved).toEqual({ teacher_subjects: 1, parent_child_subjects: 1, institute_batches: 2 })

    expect((await subjectsOf(teacher.teacherId)).map((s) => s.subject_id)).toEqual([target.id])
    expect((await db.selectFrom('parent_child_subjects').select('subject_id').where('child_id', '=', child.id).execute()).map((s) => s.subject_id)).toEqual([target.id])
    const batches = await sql<{ id: string; subject_ids: string[] }>`select id, subject_ids from institute_batches where id = any(${[batch.rows[0]!.id, batchOnlySource.rows[0]!.id]}::uuid[])`.execute(db)
    expect(Object.fromEntries(batches.rows.map((b) => [b.id, b.subject_ids]))).toEqual({ [batch.rows[0]!.id]: [target.id], [batchOnlySource.rows[0]!.id]: [target.id] }) // no repeat
    expect((await get(superAdmin, `/${source.id}`)).status).toBe(404)
    const log = await db.selectFrom('audit_logs').select(['reason', 'new_values', 'module']).where('entity_id', '=', source.id).where('action', '=', 'subject.merged').executeTakeFirstOrThrow()
    expect(log).toMatchObject({ reason: 'Same subject, two spellings', module: 'education_masters' })
    expect(log.new_values).toMatchObject({ intoSubjectId: target.id, aliasAdded: true })
  })

  it('keeps one row for a teacher who teaches both, and hands over the primary flag', async () => {
    const source = await make()
    const target = await make()
    const both = await createTeacher(masters, { status: 'approved', subjectIds: [source.id] }) // source is primary
    teachers.push(both)
    await db.insertInto('teacher_subjects').values({ teacher_id: both.teacherId, subject_id: target.id, is_primary: false }).execute()
    const solo = await createTeacher(masters, { status: 'approved', subjectIds: [target.id] })
    teachers.push(solo)

    expect((await merge(source.id, { intoSubjectId: target.id })).status).toBe(200)
    expect(await subjectsOf(both.teacherId)).toEqual([{ subject_id: target.id, is_primary: true }])
    expect(await subjectsOf(solo.teacherId)).toEqual([{ subject_id: target.id, is_primary: true }])
  })

  it('does not repeat or overflow aliases', async () => {
    const source = await make({ name: `CTest Alias Source ${uniqueTag()}` })
    const has = await make({ aliases: [source.name.toLowerCase()] })
    expect((await merge(source.id, { intoSubjectId: has.id })).body.data.aliasAdded).toBe(false)

    const source2 = await make()
    const full = await make({ aliases: Array.from({ length: 15 }, (_, i) => `alias ${i}`) })
    const res = await merge(source2.id, { intoSubjectId: full.id })
    expect(res.body.data.aliasAdded).toBe(false)
    expect(res.body.data.subject.aliases).toHaveLength(15)
  })

  it('refuses to merge a subject that has sub-subjects', async () => {
    const source = await make()
    await make({ parentSubjectId: source.id })
    const target = await make()
    const res = await merge(source.id, { intoSubjectId: target.id })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'This subject has sub-subjects. Move or merge them first.' })
    expect((await get(superAdmin, `/${source.id}`)).status).toBe(200)
  })

  it('rejects merging into itself, an unknown or deleted target, and a missing target', async () => {
    const a = await make()
    const gone = await make()
    await send('delete', superAdmin, `/${gone.id}`)
    expect((await merge(a.id, { intoSubjectId: a.id })).status).toBe(422)
    for (const intoSubjectId of [randomUUID(), gone.id]) {
      const res = await merge(a.id, { intoSubjectId })
      expect(res.status).toBe(422)
      expect(res.body.error.message).toBe('Pick the subject to merge into.')
    }
    expect((await merge(a.id, {})).status).toBe(422)
    expect((await merge(a.id, { intoSubjectId: 'nope' })).status).toBe(422)
  })

  it('frees the source’s trending slot', async () => {
    const source = await make({ isTrending: true })
    const target = await make()
    const before = await trendingCount()
    expect((await merge(source.id, { intoSubjectId: target.id })).status).toBe(200)
    expect(await trendingCount()).toBe(before - 1)
  })

  it('answers 404 for an unknown source and 403 to someone who can only read; operations admins may merge', async () => {
    const a = await make()
    const b = await make()
    expect((await merge(randomUUID(), { intoSubjectId: a.id })).status).toBe(404)
    expect((await merge('nope', { intoSubjectId: a.id })).status).toBe(404)
    expect((await merge(a.id, { intoSubjectId: b.id }, reader)).status).toBe(403)
    expect((await merge(a.id, { intoSubjectId: b.id }, ops)).status).toBe(200)
  })
})

describe('delete (FR-12.5)', () => {
  it('returns 409 CONFLICT_IN_USE with reference counts while teachers, children, batches and sub-subjects use it', async () => {
    const s = await make()
    teachers.push(await createTeacher(masters, { status: 'approved', subjectIds: [s.id] }))
    const parent = await createParent(masters)
    parents.push(parent)
    const child = await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Aarav', class_id: masters.classes.five }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('parent_child_subjects').values({ child_id: child.id, subject_id: s.id }).execute()
    await make({ parentSubjectId: s.id })
    const phone = randomPhone()
    phones.push(phone)
    const institute = await db
      .insertInto('institutes')
      .values({ name: 'Delete Test Institute', slug: `del-${randomUUID().slice(0, 8)}`, institute_type: 'coaching_centre', phone, address_line: '12 Test Road', city_id: masters.city.id, area_id: masters.areas[0]!.id, pincode: '560034', verification_status: 'approved', account_status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow()
    await sql`insert into institute_batches (institute_id, name, subject_ids) values (${institute.id}, 'Batch', ${[s.id]}::uuid[])`.execute(db)

    const res = await send('delete', superAdmin, `/${s.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_IN_USE',
      message: 'This subject is in use. Deactivate it instead.',
      details: { references: { teacher_subjects: 1, parent_child_subjects: 1, subjects: 1, institute_batches: 1 } },
    })
  })

  it('ignores a deleted batch', async () => {
    const s = await make()
    const phone = randomPhone()
    phones.push(phone)
    const institute = await db
      .insertInto('institutes')
      .values({ name: 'Delete Test Institute 2', slug: `del2-${randomUUID().slice(0, 8)}`, institute_type: 'coaching_centre', phone, address_line: '12 Test Road', city_id: masters.city.id, area_id: masters.areas[0]!.id, pincode: '560034', verification_status: 'approved', account_status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow()
    await sql`insert into institute_batches (institute_id, name, subject_ids, deleted_at) values (${institute.id}, 'Old batch', ${[s.id]}::uuid[], now())`.execute(db)
    expect((await send('delete', superAdmin, `/${s.id}`)).status).toBe(204)
  })
})
