import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { createParent, createTeacher, deleteParent, loadMasters, purgeUsersByPhone } from '../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../test/appHelpers.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { describeMasterCommon, uniqueTag } from '../../test/masterSuite.js'
import type { Body, MasterView } from '../../test/masterSuite.js'

const app = createApp()
const EMAIL_PREFIX = 'brd-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
let karnataka: string // a seeded, active state
let dormantState: string // an inactive state created for these tests
const teachers: TestTeacher[] = []
const parents: TestParent[] = []

type BoardView = MasterView & { shortName: string; type: string; state: { id: string; name: string } | null; stateId: string | null; sortOrder: number; usageCount: number }

const get = (a: { token: string }, path: string) => request(app).get(`${API}/boards${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}/boards${path}`).set(authed(a.token)).set(headers).send(body)
const patch = (id: string, body: Body, version: string) => send('patch', superAdmin, `/${id}`, body, { 'If-Match': version })

let seq = 0
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const n = ++seq
  const name = (overrides.name as string | undefined) ?? `CTest Board ${n} ${RUN}`
  const res = await send('post', as, '', { name, shortName: (overrides.name as string | undefined)?.slice(0, 40) ?? `CT${RUN} ${n}`, type: 'national', isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as BoardView
}

// Everything the test admins created, from this and any aborted earlier run.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const boards = (await db.selectFrom('boards').select('id').where('created_by', 'in', admins).execute()).map((b) => b.id)
  if (boards.length) {
    await db.deleteFrom('teacher_classes').where('board_id', 'in', boards).execute()
    await db.deleteFrom('parent_children').where('board_id', 'in', boards).execute()
    await db.deleteFrom('boards').where('id', 'in', boards).execute()
  }
  await db.deleteFrom('states').where('created_by', 'in', admins).execute()
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  karnataka = (await db.selectFrom('states').select('id').where('code', '=', 'KA').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id
  const india = await db.selectFrom('countries').select('id').where('iso2', '=', 'IN').where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  dormantState = (await db.insertInto('states').values({ country_id: india.id, name: `CTest Dormant ${RUN}`, code: `D${RUN.slice(0, 3).toUpperCase()}`, is_active: false, created_by: superAdmin.id }).returning('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describeMasterCommon<BoardView>({
  app,
  actors: () => ({ superAdmin, ops, reader, outsider }),
  path: '/boards',
  noun: 'board',
  plural: 'boards',
  notFoundMessage: 'Board not found.',
  readKey: 'education_masters.read',
  manageKey: 'education_masters.manage',
  entityType: 'boards',
  auditPrefix: 'board',
  auditModule: 'education_masters',
  make,
  edit: { field: 'sortOrder', first: 51, second: 52 },
  uniqueField: 'shortName',
  recreate: (b) => ({ name: b.name, shortName: b.shortName, type: b.type, stateId: b.stateId }),
  duplicate: { message: 'A board with this name already exists.', field: 'shortName' },
  badQueries: ['type=college', 'stateId=ka'],
})

describe('create (FR-13.2)', () => {
  it('creates a board, normalises input, defaults flags and audits it', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '', { name: `  Central   Board ${tag} `, shortName: `  ${tag}  CBSE `, type: 'national' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: `Central Board ${tag}`, shortName: `${tag} CBSE`, type: 'national', state: null, stateId: null, isActive: true, sortOrder: 0, usageCount: 0, deletedAt: null })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'boards').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'board.created', actor_id: superAdmin.id, module: 'education_masters' })
    expect(log.new_values).toMatchObject({ shortName: `${tag} CBSE`, type: 'national' })
  })

  it('creates a state board with its state', async () => {
    const b = await make({ type: 'state', stateId: karnataka })
    expect(b).toMatchObject({ type: 'state', stateId: karnataka, state: { id: karnataka, name: 'Karnataka' } })
  })

  it.each(['university', 'international', 'other'])('creates a %s board without a state', async (type) => {
    expect((await make({ type })).type).toBe(type)
  })

  it.each([
    ['name too short', { name: 'ab' }, 'name', 'Full name must be 3–120 characters.'],
    ['name too long', { name: 'x'.repeat(121) }, 'name', 'Full name must be 3–120 characters.'],
    ['short name too short', { shortName: 'x' }, 'shortName', 'Short name must be 2–40 characters.'],
    ['short name too long', { shortName: 'x'.repeat(41) }, 'shortName', 'Short name must be 2–40 characters.'],
    ['unknown type', { type: 'college' }, 'type', 'Pick a value from the list.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder fractional', { sortOrder: 1.5 }, 'sortOrder', 'Order must be a whole number.'],
    ['state that is not an id', { type: 'state', stateId: 'karnataka' }, 'stateId', 'Pick an active parent record.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const n = ++seq
    const res = await send('post', superAdmin, '', { name: `CTest bad ${n} ${RUN}`, shortName: `CTbad${RUN} ${n}`, type: 'national', ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('needs a state for a state board, and refuses one for any other board', async () => {
    const n = ++seq
    const base = { name: `CTest pair ${n} ${RUN}`, shortName: `CTpair${RUN} ${n}` }
    const missing = await send('post', superAdmin, '', { ...base, type: 'state' })
    expect(missing.status).toBe(422)
    expect(missing.body.error.details).toContainEqual({ path: 'stateId', message: 'Pick the state for a state board.' })
    const extra = await send('post', superAdmin, '', { ...base, type: 'national', stateId: karnataka })
    expect(extra.status).toBe(422)
    expect(extra.body.error.details).toContainEqual({ path: 'stateId', message: 'Only state boards have a state.' })
    expect(await db.selectFrom('boards').select('id').where('name', '=', base.name).executeTakeFirst()).toBeUndefined()
  })

  it('requires the state to exist and be active (422)', async () => {
    for (const stateId of [randomUUID(), dormantState]) {
      const n = ++seq
      const res = await send('post', superAdmin, '', { name: `CTest orphan ${n} ${RUN}`, shortName: `CTorph${RUN} ${n}`, type: 'state', stateId })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Pick an active parent record.' })
    }
  })

  it('allows two boards with the same full name but not the same short name', async () => {
    const a = await make()
    const same = await send('post', superAdmin, '', { name: a.name, shortName: `${a.shortName} two`, type: 'national' })
    expect(same.status).toBe(201)
    const clash = await send('post', superAdmin, '', { name: 'Another long name', shortName: a.shortName.toUpperCase(), type: 'national' })
    expect(clash.status).toBe(409)
    expect(clash.body.error.message).toBe('A board with this name already exists.')
  })
})

describe('read (FR-13.1)', () => {
  it('lists the seeded boards with their state and the documented fields', async () => {
    const res = await get(reader, '?pageSize=100&sort=name:asc')
    expect(res.status).toBe(200)
    const cbse = res.body.data.find((b: BoardView) => b.shortName === 'CBSE')
    expect(cbse).toMatchObject({ name: 'Central Board of Secondary Education', type: 'national', state: null })
    expect(res.body.data.find((b: BoardView) => b.shortName === 'Karnataka State Board')).toMatchObject({ type: 'state', state: { name: 'Karnataka' } })
    expect(Object.keys(cbse).sort()).toEqual(['createdAt', 'deletedAt', 'id', 'isActive', 'name', 'shortName', 'sortOrder', 'state', 'stateId', 'type', 'updatedAt', 'usageCount'].sort())
  })

  it('filters by type and by state', async () => {
    const tag = uniqueTag()
    const nat = await make({ name: `${tag} National` })
    const st = await make({ name: `${tag} State`, type: 'state', stateId: karnataka })
    const uni = await make({ name: `${tag} Uni`, type: 'university' })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `?q=${q}${extra}`)).body.data.map((r: BoardView) => r.id).sort()
    expect(await ids('')).toEqual([nat.id, st.id, uni.id].sort())
    expect(await ids('&type=state')).toEqual([st.id])
    expect(await ids('&type=university')).toEqual([uni.id])
    expect(await ids(`&stateId=${karnataka}`)).toEqual([st.id])
  })

  it('searches the full name and the short name', async () => {
    const tag = uniqueTag()
    const b = await make({ name: `Board of ${tag} Studies`, shortName: `${tag}-S` })
    for (const term of [tag.toUpperCase() + '-S', `Board of ${tag}`]) {
      expect((await get(reader, `?q=${encodeURIComponent(term)}`)).body.data.map((r: BoardView) => r.id), term).toContain(b.id)
    }
  })

  it('returns the live usage count of a board', async () => {
    const b = await make()
    const teacher = await createTeacher(masters, { status: 'approved', classIds: [masters.classes.five] })
    teachers.push(teacher)
    await db.updateTable('teacher_classes').set({ board_id: b.id }).where('teacher_id', '=', teacher.teacherId).execute()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Riya', class_id: masters.classes.five, board_id: b.id }).execute()
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Gone', class_id: masters.classes.five, board_id: b.id, deleted_at: new Date() }).execute()
    expect((await get(reader, `/${b.id}`)).body.data.usageCount).toBe(2)
  })
})

describe('update (FR-13.3)', () => {
  it('turns a board into a state board when the state comes with it', async () => {
    const b = await make()
    const res = await patch(b.id, { type: 'state', stateId: karnataka }, b.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ type: 'state', stateId: karnataka })
  })

  it('refuses to make a board a state board without a state, and to leave a state attached to a non-state board', async () => {
    const national = await make()
    const noState = await patch(national.id, { type: 'state' }, national.updatedAt)
    expect(noState.status).toBe(422)
    expect(noState.body.error.details).toContainEqual({ path: 'stateId', message: 'Pick the state for a state board.' })

    const stateBoard = await make({ type: 'state', stateId: karnataka })
    const staysAttached = await patch(stateBoard.id, { type: 'national' }, stateBoard.updatedAt)
    expect(staysAttached.status).toBe(422)
    expect(staysAttached.body.error.details).toContainEqual({ path: 'stateId', message: 'Only state boards have a state.' })
    const cleared = await patch(stateBoard.id, { type: 'national', stateId: null }, stateBoard.updatedAt)
    expect(cleared.status).toBe(200)
    expect(cleared.body.data).toMatchObject({ type: 'national', stateId: null, state: null })
    const stored = await db.selectFrom('boards').select(['type', 'state_id']).where('id', '=', stateBoard.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ type: 'national', state_id: null })
  })

  it('moves a state board to another active state, and refuses an inactive or unknown one', async () => {
    const other = await db.selectFrom('states').select('id').where('code', '=', 'MH').where('deleted_at', 'is', null).executeTakeFirstOrThrow()
    const b = await make({ type: 'state', stateId: karnataka })
    for (const stateId of [dormantState, randomUUID()]) {
      const res = await patch(b.id, { stateId }, b.updatedAt)
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'stateId', message: 'Pick an active parent record.' })
    }
    const moved = await patch(b.id, { stateId: other.id }, b.updatedAt)
    expect(moved.body.data.state.name).toBe('Maharashtra')
  })

  it('validates the fields it changes', async () => {
    const b = await make()
    expect((await patch(b.id, { type: 'college' }, b.updatedAt)).status).toBe(422)
    expect((await patch(b.id, { shortName: 'x' }, b.updatedAt)).status).toBe(422)
    expect((await patch(b.id, { stateId: 'ka' }, b.updatedAt)).status).toBe(422)
  })
})

describe('delete (FR-13.5)', () => {
  it('returns 409 CONFLICT_IN_USE with reference counts while teachers and children use it', async () => {
    const b = await make()
    const teacher = await createTeacher(masters, { status: 'approved', classIds: [masters.classes.five] })
    teachers.push(teacher)
    await db.updateTable('teacher_classes').set({ board_id: b.id }).where('teacher_id', '=', teacher.teacherId).execute()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Aarav', class_id: masters.classes.five, board_id: b.id }).execute()

    const res = await send('delete', superAdmin, `/${b.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_IN_USE', message: 'This board is in use. Deactivate it instead.', details: { references: { teacher_classes: 1, parent_children: 1 } } })
    expect((await get(superAdmin, `/${b.id}`)).status).toBe(200)
  })

  it('ignores soft-deleted children when checking usage', async () => {
    const b = await make()
    const parent = await createParent(masters)
    parents.push(parent)
    await db.insertInto('parent_children').values({ parent_id: parent.parentId, child_name: 'Gone', class_id: masters.classes.five, board_id: b.id, deleted_at: new Date() }).execute()
    expect((await send('delete', superAdmin, `/${b.id}`)).status).toBe(204)
  })
})
