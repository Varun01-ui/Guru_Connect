import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { createParent, deleteParent, loadMasters } from '../../test/appHelpers.js'
import type { Masters, TestParent } from '../../test/appHelpers.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const EMAIL_PREFIX = 'st-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)

let superAdmin: TestAdmin
let ops: TestAdmin // locations.read + locations.manage, not a super admin
let reader: TestAdmin // verification_admin: locations.read only
let outsider: TestAdmin // finance_admin: no location permissions
let masters: Masters
const parents: TestParent[] = []
let home: { id: string; iso2: string } // the country most fixtures live in
let other: { id: string; iso2: string } // a second active country
let dormant: { id: string; iso2: string } // an inactive country

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)
const importCsv = (a: { token: string }, csv: string, query = '') =>
  request(app).post(`${API}/states/import${query}`).set(authed(a.token)).set('Content-Type', 'text/csv').send(csv)

let seq = 0
type Body = Record<string, unknown>
type StateView = {
  id: string
  country: { id: string; name: string }
  countryId: string
  name: string
  code: string
  type: string
  isActive: boolean
  sortOrder: number
  cityCount: number
  updatedAt: string
  deletedAt: string | null
}
const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`
const nextCode = () => `T${(++seq).toString(36).toUpperCase()}`

// Y? is not a real country in the seed, so these never clash with India or the countries module's own tests.
let countrySeq = 0
async function makeCountry(isActive = true) {
  const iso2 = `Y${String.fromCharCode(65 + countrySeq++)}`
  const res = await send('post', superAdmin, '/countries', { name: `CTest Land ${iso2} ${RUN}`, iso2, iso3: `${iso2}Y`, phoneCode: '+998', currencyCode: 'XTS', isActive })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { id: res.body.data.id as string, iso2 }
}
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const code = nextCode()
  const res = await send('post', as, '/states', { countryId: home.id, name: `CTest State ${code} ${RUN}`, code, type: 'state', isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as StateView
}
const patch = (id: string, body: Body, version: string, as: { token: string } = superAdmin) => send('patch', as, `/states/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'states').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
const addCity = (stateId: string, deleted = false) =>
  db.insertInto('cities').values({ id: randomUUID(), state_id: stateId, name: `CTest City ${randomUUID().slice(0, 8)}`, slug: `ctest-city-${randomUUID().slice(0, 8)}`, ...(deleted ? { deleted_at: new Date() } : {}) }).execute()

// Everything the test admins created, from this and any aborted earlier run: codes and names are unique, and the
// admin rows cannot be deleted while states or countries still point at them.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const states = (await db.selectFrom('states').select('id').where('created_by', 'in', admins).execute()).map((s) => s.id)
  if (states.length) {
    await db.deleteFrom('cities').where('state_id', 'in', states).execute()
    await db.deleteFrom('boards').where('state_id', 'in', states).execute()
    await db.updateTable('parents').set({ state_id: null }).where('state_id', 'in', states).execute()
    await db.deleteFrom('states').where('id', 'in', states).execute()
  }
  const countries = (await db.selectFrom('countries').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
  if (countries.length) {
    await db.deleteFrom('states').where('country_id', 'in', countries).execute()
    await db.deleteFrom('countries').where('id', 'in', countries).execute()
  }
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  home = await makeCountry()
  other = await makeCountry()
  dormant = await makeCountry(false)
})

afterAll(async () => {
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describe('permissions (section 13 / 20)', () => {
  it('rejects anonymous callers', async () => {
    expect((await request(app).get(`${API}/states`)).status).toBe(401)
  })

  it('lets a read-only admin list but tells them they cannot change anything', async () => {
    const s = await make()
    expect((await get(reader, '/states')).status).toBe(200)
    expect((await get(reader, `/states/${s.id}`)).status).toBe(200)
    for (const res of [
      await send('post', reader, '/states', { countryId: home.id, name: 'CTest nope', code: 'NP' }),
      await patch(s.id, { sortOrder: 51 }, s.updatedAt, reader),
      await send('post', reader, `/states/${s.id}/deactivate`, {}),
      await send('delete', reader, `/states/${s.id}`),
      await importCsv(reader, 'country_iso2,name,code,type\n'),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can view states but not change them.', details: { required: ['locations.manage'] } })
    }
  })

  it('blocks admins with no location permission from reading', async () => {
    const res = await get(outsider, '/states')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['locations.read'] } })
  })

  it('lets an operations admin manage states', async () => {
    const s = await make({}, ops)
    expect((await patch(s.id, { sortOrder: 51 }, s.updatedAt, ops)).status).toBe(200)
  })
})

describe('create (FR-8.2)', () => {
  it('creates a state, normalises input and audits it', async () => {
    const code = nextCode()
    const res = await send('post', superAdmin, '/states', { countryId: home.id, name: `  CTest   Kerala ${code} `, code: code.toLowerCase(), type: 'union_territory' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      country: { id: home.id },
      countryId: home.id,
      name: `CTest Kerala ${code}`,
      code,
      type: 'union_territory',
      isActive: true,
      sortOrder: 0,
      cityCount: 0,
      deletedAt: null,
    })
    expect(res.body.data.country.name).toContain('CTest Land')
    const stored = await db.selectFrom('states').select(['created_by', 'updated_by']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ created_by: superAdmin.id, updated_by: superAdmin.id })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'states').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'state.created', actor_id: superAdmin.id, module: 'locations' })
    expect(log.new_values).toMatchObject({ countryId: home.id, code, type: 'union_territory' })
  })

  it('defaults to a state type, active, order 0', async () => {
    const code = nextCode()
    const res = await send('post', superAdmin, '/states', { countryId: home.id, name: `CTest Defaults ${code}`, code })
    expect(res.body.data).toMatchObject({ type: 'state', isActive: true, sortOrder: 0 })
  })

  it('can be created inactive', async () => {
    expect((await make({ isActive: false })).isActive).toBe(false)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'State name must be 2–60 characters.'],
    ['name too long', { name: 'x'.repeat(61) }, 'name', 'State name must be 2–60 characters.'],
    ['empty code', { code: '' }, 'code', 'Code uses 1–5 capital letters or digits.'],
    ['code too long', { code: 'ABCDEF' }, 'code', 'Code uses 1–5 capital letters or digits.'],
    ['code with a symbol', { code: 'K-L' }, 'code', 'Code uses 1–5 capital letters or digits.'],
    ['unknown type', { type: 'territory' }, 'type', 'Pick a value from the list.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['sortOrder fractional', { sortOrder: 1.5 }, 'sortOrder', 'Order must be a whole number.'],
    ['country not a uuid', { countryId: 'india' }, 'countryId', 'Pick an active parent record.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '/states', { countryId: home.id, name: `CTest bad ${RUN}`, code: nextCode(), ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('rejects a missing country, a missing field and an unknown field', async () => {
    const res = await send('post', superAdmin, '/states', { name: `CTest no country ${RUN}`, code: nextCode() })
    expect(res.status).toBe(422)
    expect(res.body.error.details).toContainEqual({ path: 'countryId', message: 'Pick an active parent record.' })
    expect((await send('post', superAdmin, '/states', { countryId: home.id })).status).toBe(422)
    expect((await send('post', superAdmin, '/states', { countryId: home.id, name: `CTest extra ${RUN}`, code: nextCode(), slug: 'x' })).status).toBe(422)
  })

  it('requires the parent country to exist, be active and not be deleted (422)', async () => {
    const gone = await makeCountry()
    expect((await send('delete', superAdmin, `/countries/${gone.id}`)).status).toBe(204)
    for (const countryId of [randomUUID(), dormant.id, gone.id]) {
      const res = await send('post', superAdmin, '/states', { countryId, name: `CTest orphan ${RUN}`, code: nextCode() })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Pick an active parent record.' })
      expect(res.body.error.details).toContainEqual({ path: 'countryId', message: 'Pick an active parent record.' })
    }
    expect(await db.selectFrom('states').select('id').where('name', '=', `CTest orphan ${RUN}`).executeTakeFirst()).toBeUndefined()
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate name within the country, ignoring case', async () => {
    const s = await make()
    const res = await send('post', superAdmin, '/states', { countryId: home.id, name: s.name.toUpperCase(), code: nextCode() })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A state with this name already exists.', details: { field: 'name' } })
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate code within the country and writes nothing', async () => {
    const s = await make()
    const res = await send('post', superAdmin, '/states', { countryId: home.id, name: `CTest dup-code ${RUN}`, code: s.code })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A state with this code already exists in this country.', details: { field: 'code' } })
    expect(await db.selectFrom('states').select('id').where('name', '=', `CTest dup-code ${RUN}`).executeTakeFirst()).toBeUndefined()
  })

  it('allows the same name and code in a different country', async () => {
    const s = await make()
    const res = await send('post', superAdmin, '/states', { countryId: other.id, name: s.name, code: s.code })
    expect(res.status).toBe(201)
    expect(res.body.data.countryId).toBe(other.id)
  })
})

describe('read (FR-8.1)', () => {
  it('returns one state with its country and live city count', async () => {
    const s = await make()
    await addCity(s.id)
    await addCity(s.id)
    await addCity(s.id, true)
    const res = await get(reader, `/states/${s.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: s.id, country: { id: home.id }, cityCount: 2 })
  })

  it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await get(superAdmin, `/states/${id}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'State not found.' })
    }
  })

  it('lists the seeded Indian states with paging meta and the documented fields', async () => {
    const india = await db.selectFrom('countries').select('id').where('iso2', '=', 'IN').where('deleted_at', 'is', null).executeTakeFirstOrThrow()
    const res = await get(reader, `/states?countryId=${india.id}&pageSize=100&sort=name:asc`)
    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBeGreaterThanOrEqual(13)
    expect(res.body.data.find((s: StateView) => s.code === 'KA')).toMatchObject({ name: 'Karnataka', country: { id: india.id, name: 'India' } })
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['cityCount', 'code', 'country', 'countryId', 'createdAt', 'deletedAt', 'id', 'isActive', 'name', 'sortOrder', 'type', 'updatedAt'].sort())
  })

  it('pages with meta', async () => {
    const tag = uniqueTag()
    for (const n of ['A', 'B', 'C']) await make({ name: `${tag} ${n}` })
    const q = encodeURIComponent(tag)
    expect((await get(reader, `/states?q=${q}&pageSize=2`)).body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
    expect((await get(reader, `/states?q=${q}&pageSize=2&page=2`)).body.data).toHaveLength(1)
  })

  it('sorts by name and by order, in either direction', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, sortOrder: 61 })
    const b = await make({ name: `${tag} B`, sortOrder: 60 })
    const q = encodeURIComponent(tag)
    const ids = async (sort: string) => (await get(reader, `/states?q=${q}&sort=${sort}`)).body.data.map((r: StateView) => r.id)
    expect(await ids('name:asc')).toEqual([a.id, b.id])
    expect(await ids('name:desc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:asc')).toEqual([b.id, a.id])
    expect(await ids('sortOrder:desc')).toEqual([a.id, b.id])
  })

  it('searches the name by prefix and the code exactly, case-insensitively', async () => {
    const tag = uniqueTag()
    const s = await make({ name: `${tag} Pradesh` })
    for (const term of [tag, tag.toUpperCase(), s.code, s.code.toLowerCase()]) {
      expect((await get(reader, `/states?q=${encodeURIComponent(term)}&countryId=${home.id}`)).body.data.map((r: StateView) => r.id), term).toContain(s.id)
    }
  })

  it('treats % and _ in the search term literally', async () => {
    const res = await get(reader, '/states?q=%25')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('filters by country, type and active state', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, type: 'state', isActive: true })
    const b = await make({ name: `${tag} B`, type: 'union_territory', isActive: false })
    const c = await make({ name: `${tag} C`, countryId: other.id, type: 'state', isActive: true })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `/states?q=${q}${extra}`)).body.data.map((r: StateView) => r.id).sort()
    expect(await ids('')).toEqual([a.id, b.id, c.id].sort())
    expect(await ids(`&countryId=${home.id}`)).toEqual([a.id, b.id].sort())
    expect(await ids(`&countryId=${other.id}`)).toEqual([c.id])
    expect(await ids('&type=union_territory')).toEqual([b.id])
    expect(await ids('&active=true')).toEqual([a.id, c.id].sort())
    expect(await ids(`&active=false&countryId=${home.id}`)).toEqual([b.id])
  })

  it.each([['pageSize=101'], ['page=0'], ['sort=code:asc'], ['active=maybe'], ['countryId=india'], ['type=territory'], ['fields=name,secret']])('rejects ?%s with 422', async (qs) => {
    const res = await get(reader, `/states?${qs}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('hides deleted rows, and only a super admin may ask for them', async () => {
    const s = await make()
    expect((await send('delete', superAdmin, `/states/${s.id}`)).status).toBe(204)
    const q = encodeURIComponent(s.name)
    expect((await get(reader, `/states?q=${q}`)).body.data.map((r: StateView) => r.id)).not.toContain(s.id)
    expect((await get(reader, `/states/${s.id}`)).status).toBe(404)
    expect((await get(ops, `/states?q=${q}&includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/states/${s.id}?includeDeleted=true`)).status).toBe(403)
    expect((await get(superAdmin, `/states?q=${q}&includeDeleted=true`)).body.data.find((r: StateView) => r.id === s.id).deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/states/${s.id}?includeDeleted=true`)).status).toBe(200)
  })
})

describe('dropdown mode (FR-8 S2)', () => {
  it('returns only the requested fields for one country, unpaginated, active rows only', async () => {
    const live = await make({ isActive: true })
    const inactive = await make({ isActive: false })
    const elsewhere = await make({ countryId: other.id })
    const res = await get(reader, `/states?active=true&countryId=${home.id}&fields=id,name,code`)
    expect(res.status).toBe(200)
    expect(res.body.meta).toBeUndefined()
    expect(res.body.data.find((r: StateView) => r.id === live.id)).toEqual({ id: live.id, name: live.name, code: live.code })
    expect(res.body.data.some((r: StateView) => r.id === inactive.id)).toBe(false)
    expect(res.body.data.some((r: StateView) => r.id === elsewhere.id)).toBe(false)
  })

  it('purges the cached list on every write in the module', async () => {
    const url = `/states?active=true&countryId=${home.id}&fields=id,name`
    const before = await get(reader, url) // warms the cache
    const created = await make()
    const afterCreate = await get(reader, url)
    expect(afterCreate.body.data.some((r: StateView) => r.id === created.id)).toBe(true)
    expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

    await send('post', superAdmin, `/states/${created.id}/deactivate`, {})
    expect((await get(reader, url)).body.data.some((r: StateView) => r.id === created.id)).toBe(false)
    await send('post', superAdmin, `/states/${created.id}/activate`, {})
    expect((await get(reader, url)).body.data.some((r: StateView) => r.id === created.id)).toBe(true)

    const edited = (await get(reader, `/states/${created.id}`)).body.data
    await patch(created.id, { name: `${created.name} Renamed` }, edited.updatedAt)
    expect((await get(reader, url)).body.data.find((r: StateView) => r.id === created.id).name).toBe(`${created.name} Renamed`)

    await send('delete', superAdmin, `/states/${created.id}`)
    expect((await get(reader, url)).body.data.some((r: StateView) => r.id === created.id)).toBe(false)
  })
})

describe('update (FR-8.3)', () => {
  it('changes only the sent fields, returns the new version and audits the diff', async () => {
    const s = await make({ sortOrder: 50, type: 'state' })
    const res = await patch(s.id, { sortOrder: 52, type: 'union_territory' }, s.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: s.id, name: s.name, sortOrder: 52, type: 'union_territory' })
    expect(res.body.data.updatedAt).not.toBe(s.updatedAt)
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', s.id).where('action', '=', 'state.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ sortOrder: 50, type: 'state' })
    expect(log.new_values).toEqual({ sortOrder: 52, type: 'union_territory' })
  })

  it('can change the code, which must stay unique within the country', async () => {
    const a = await make()
    const b = await make()
    const free = nextCode()
    expect((await patch(a.id, { code: free.toLowerCase() }, a.updatedAt)).body.data.code).toBe(free)
    const clash = await patch(b.id, { code: free }, b.updatedAt)
    expect(clash.status).toBe(409)
    expect(clash.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'code' } })
  })

  it('treats an unchanged value as a no-op: same version, no audit row', async () => {
    const s = await make()
    const res = await patch(s.id, { sortOrder: s.sortOrder, countryId: s.countryId, code: s.code }, s.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(s.updatedAt)
    expect(await auditActions(s.id)).toEqual(['state.created'])
  })

  it('moves a state without cities to another active country (FR-8.S1) and audits it', async () => {
    const s = await make()
    const res = await patch(s.id, { countryId: other.id }, s.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ countryId: other.id, country: { id: other.id } })
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', s.id).where('action', '=', 'state.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ countryId: home.id })
    expect(log.new_values).toEqual({ countryId: other.id })
  })

  it("refuses to move a state that has cities, with 409 CONFLICT_STATE (FR-8.S1)", async () => {
    const s = await make()
    await addCity(s.id)
    const res = await patch(s.id, { countryId: other.id, name: `${s.name} moved` }, s.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "A state that has cities can't move to another country. Create a new state instead.", details: { cities: 1 } })
    const stored = await db.selectFrom('states').select(['country_id', 'name']).where('id', '=', s.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ country_id: home.id, name: s.name })
  })

  it('does not count deleted cities when deciding whether a state can move', async () => {
    const s = await make()
    await addCity(s.id, true)
    expect((await patch(s.id, { countryId: other.id }, s.updatedAt)).status).toBe(200)
  })

  it('refuses to move a state to a missing, inactive or deleted country (422)', async () => {
    const s = await make()
    for (const countryId of [randomUUID(), dormant.id]) {
      const res = await patch(s.id, { countryId }, s.updatedAt)
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'countryId', message: 'Pick an active parent record.' })
    }
  })

  it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
    const s = await make()
    expect((await patch(s.id, { sortOrder: 51 }, s.updatedAt)).status).toBe(200)
    const stale = await patch(s.id, { sortOrder: 52 }, s.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this state. Reload.', details: { current: { id: s.id, sortOrder: 51 } } })
  })

  it('requires an If-Match header', async () => {
    const s = await make()
    const res = await send('patch', superAdmin, `/states/${s.id}`, { sortOrder: 51 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an empty body, an invalid value and an unknown field', async () => {
    const s = await make()
    expect((await patch(s.id, {}, s.updatedAt)).status).toBe(422)
    expect((await patch(s.id, { type: 'territory' }, s.updatedAt)).status).toBe(422)
    expect((await patch(s.id, { cityCount: 3 }, s.updatedAt)).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE when renaming onto another state of the country', async () => {
    const a = await make()
    const b = await make()
    const res = await patch(b.id, { name: a.name.toLowerCase() }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })

  it('returns 409 CONFLICT_DUPLICATE when moving into a country that already has that name or code', async () => {
    const a = await make()
    await send('post', superAdmin, '/states', { countryId: other.id, name: a.name, code: nextCode() })
    const res = await patch(a.id, { countryId: other.id }, a.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })

  it('returns 404 for an unknown or deleted state', async () => {
    const s = await make()
    await send('delete', superAdmin, `/states/${s.id}`)
    expect((await patch(s.id, { sortOrder: 1 }, s.updatedAt)).status).toBe(404)
    expect((await patch(randomUUID(), { sortOrder: 1 }, s.updatedAt)).status).toBe(404)
    expect((await patch('nope', { sortOrder: 1 }, s.updatedAt)).status).toBe(404)
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const s = await make()
    const [x, y] = await Promise.all([patch(s.id, { sortOrder: 51 }, s.updatedAt), patch(s.id, { sortOrder: 52 }, s.updatedAt)])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })
})

describe('activate / deactivate (FR-8.4)', () => {
  it('toggles the flag, records the reason and keeps the row and its cities', async () => {
    const s = await make({ isActive: true })
    await addCity(s.id)
    const off = await send('post', superAdmin, `/states/${s.id}/deactivate`, { reason: 'No coverage yet' })
    expect(off.status).toBe(200)
    expect(off.body.data).toMatchObject({ isActive: false, cityCount: 1 })
    expect((await send('post', superAdmin, `/states/${s.id}/activate`)).body.data.isActive).toBe(true)
    expect(await auditActions(s.id)).toEqual(['state.created', 'state.deactivated', 'state.activated'])
    const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', s.id).where('action', '=', 'state.deactivated').executeTakeFirstOrThrow()
    expect(log.reason).toBe('No coverage yet')
  })

  it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
    const s = await make({ isActive: true })
    const again = await send('post', superAdmin, `/states/${s.id}/activate`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(s.updatedAt)
    expect(await auditActions(s.id)).toEqual(['state.created'])
  })

  it('returns 404 for an unknown state and 422 for an over-long reason', async () => {
    expect((await send('post', superAdmin, `/states/${randomUUID()}/activate`, {})).status).toBe(404)
    const s = await make()
    expect((await send('post', superAdmin, `/states/${s.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
  })
})

describe('delete (FR-8.5)', () => {
  it('soft-deletes an unused state and frees its name and code', async () => {
    const s = await make()
    expect((await send('delete', superAdmin, `/states/${s.id}`)).status).toBe(204)
    const stored = await db.selectFrom('states').select(['deleted_at', 'deleted_by']).where('id', '=', s.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)
    expect(await auditActions(s.id)).toEqual(['state.created', 'state.deleted'])
    expect((await send('post', superAdmin, '/states', { countryId: home.id, name: s.name, code: s.code })).status).toBe(201)
    expect((await send('delete', superAdmin, `/states/${s.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_IN_USE with reference counts while cities, boards and parents use it', async () => {
    const s = await make()
    await addCity(s.id)
    await addCity(s.id)
    await db.insertInto('boards').values({ id: randomUUID(), name: `CTest Board ${RUN}`, short_name: `CT${RUN}`, type: 'state', state_id: s.id }).execute()
    const parent = await createParent(masters, { stateId: s.id })
    parents.push(parent)

    const res = await send('delete', superAdmin, `/states/${s.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_IN_USE',
      message: 'This state is in use. Deactivate it instead.',
      details: { references: { cities: 2, boards: 1, parents: 1 } },
    })
    expect((await get(superAdmin, `/states/${s.id}`)).status).toBe(200)
    expect(await auditActions(s.id)).toEqual(['state.created'])
  })

  it('ignores soft-deleted cities when checking usage', async () => {
    const s = await make()
    await addCity(s.id, true)
    expect((await send('delete', superAdmin, `/states/${s.id}`)).status).toBe(204)
  })

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await send('delete', superAdmin, `/states/${randomUUID()}`)).status).toBe(404)
    expect((await send('delete', superAdmin, '/states/nope')).status).toBe(404)
  })
})

describe('restore (FR-8.6)', () => {
  it('lets a super admin undelete a state', async () => {
    const s = await make()
    await send('delete', superAdmin, `/states/${s.id}`)
    const res = await send('post', superAdmin, `/states/${s.id}/restore`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: s.id, deletedAt: null, name: s.name })
    expect(await auditActions(s.id)).toEqual(['state.created', 'state.deleted', 'state.restored'])
  })

  it('is refused for an admin who is not a super admin, even with locations.manage', async () => {
    const s = await make()
    await send('delete', superAdmin, `/states/${s.id}`)
    const res = await send('post', ops, `/states/${s.id}/restore`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await get(superAdmin, `/states/${s.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_DUPLICATE when the name or code was taken meanwhile', async () => {
    const s = await make()
    await send('delete', superAdmin, `/states/${s.id}`)
    await send('post', superAdmin, '/states', { countryId: home.id, name: s.name, code: s.code })
    const res = await send('post', superAdmin, `/states/${s.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
  })

  it('refuses to bring a state back under a country that is itself deleted', async () => {
    const land = await makeCountry()
    const s = await make({ countryId: land.id })
    await send('delete', superAdmin, `/states/${s.id}`)
    expect((await send('delete', superAdmin, `/countries/${land.id}`)).status).toBe(204)
    const res = await send('post', superAdmin, `/states/${s.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE' })
    expect(res.body.error.message).toContain('Restore CTest Land')
  })

  it('returns 409 CONFLICT_STATE for a state that is not deleted, 404 for an unknown one', async () => {
    const s = await make()
    const live = await send('post', superAdmin, `/states/${s.id}/restore`)
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/states/${randomUUID()}/restore`)).status).toBe(404)
  })
})

describe('CSV import (FR-8.S2)', () => {
  const header = 'country_iso2,name,code,type'
  const names = async (iso: string) =>
    (await db.selectFrom('states').innerJoin('countries as c', 'c.id', 'states.country_id').select('states.name').where('c.iso2', '=', iso).where('states.deleted_at', 'is', null).execute()).map((r) => r.name).sort()
  const tag = () => `Imp${uniqueTag()}`

  it('checks the file without saving anything when dryRun is set', async () => {
    const t = tag()
    const csv = `${header}\n${home.iso2},${t} One,${nextCode()},state\n${home.iso2},${t} Two,${nextCode()},union_territory\n`
    const before = await db.selectFrom('audit_logs').select('id').where('action', '=', 'state.imported').execute()
    const res = await importCsv(superAdmin, csv, '?dryRun=true')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ dryRun: true, total: 2, skipped: [] })
    expect(res.body.data.created.map((c: { row: number }) => c.row)).toEqual([2, 3])
    expect((await names(home.iso2)).some((n) => n.startsWith(t))).toBe(false)
    expect((await db.selectFrom('audit_logs').select('id').where('action', '=', 'state.imported').execute()).length).toBe(before.length)
  })

  it('creates every row in one go and records one audit entry', async () => {
    const t = tag()
    const c1 = nextCode()
    const c2 = nextCode()
    const res = await importCsv(superAdmin, `${header}\n${home.iso2},${t} One,${c1},state\n${other.iso2},${t} Two,${c2},Union Territory\n`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ dryRun: false, total: 2, skipped: [] })
    expect(res.body.data.created).toEqual([{ row: 2, label: `${t} One (${c1})` }, { row: 3, label: `${t} Two (${c2})` }])

    const rows = await db.selectFrom('states').select(['name', 'type', 'created_by', 'country_id']).where('name', 'like', `${t}%`).orderBy('name').execute()
    expect(rows).toEqual([
      { name: `${t} One`, type: 'state', created_by: superAdmin.id, country_id: home.id },
      { name: `${t} Two`, type: 'union_territory', created_by: superAdmin.id, country_id: other.id },
    ])
    const log = await db.selectFrom('audit_logs').select(['module', 'actor_id', 'new_values']).where('action', '=', 'state.imported').orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ module: 'locations', actor_id: superAdmin.id })
    expect((log.new_values as { created: unknown[] }).created).toHaveLength(2)
  })

  it('skips rows that already exist instead of failing, and imports the rest', async () => {
    const existing = await make()
    const t = tag()
    const fresh = nextCode()
    const csv = `${header}\n${home.iso2},${existing.name},${nextCode()},state\n${home.iso2},${t} New,${existing.code},state\n${home.iso2},${t} Fresh,${fresh},state\n`
    const res = await importCsv(superAdmin, csv)
    expect(res.status).toBe(200)
    expect(res.body.data.created).toEqual([{ row: 4, label: `${t} Fresh (${fresh})` }])
    expect(res.body.data.skipped).toEqual([
      { row: 2, label: expect.stringContaining(existing.name), reason: 'A state with this name already exists.' },
      { row: 3, label: `${t} New (${existing.code})`, reason: 'A state with this code already exists.' },
    ])
  })

  it('does nothing and still succeeds when every row already exists', async () => {
    const existing = await make()
    const res = await importCsv(superAdmin, `${header}\n${home.iso2},${existing.name},${existing.code},state\n`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ created: [], total: 1 })
    expect(res.body.data.skipped).toHaveLength(1)
  })

  it('purges the cached dropdown so the new states appear at once', async () => {
    const url = `/states?active=true&countryId=${home.id}&fields=id,name`
    await get(reader, url) // warm
    const t = tag()
    await importCsv(superAdmin, `${header}\n${home.iso2},${t} Cached,${nextCode()},state\n`)
    expect((await get(reader, url)).body.data.some((s: StateView) => s.name === `${t} Cached`)).toBe(true)
  })

  it('reads quoted fields, CRLF line ends, a BOM, a blank type and mixed case', async () => {
    const t = tag()
    const c1 = nextCode()
    const c2 = nextCode()
    const csv = `﻿${header.toUpperCase()}\r\n${home.iso2.toLowerCase()},"${t}, Quoted",${c1.toLowerCase()},\r\n${home.iso2},  ${t}   Spaced  ,${c2},UNION-TERRITORY\r\n\r\n`
    const res = await importCsv(superAdmin, csv)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = await db.selectFrom('states').select(['name', 'code', 'type']).where('name', 'like', `${t}%`).execute()
    expect(rows).toHaveLength(2)
    expect(rows).toContainEqual({ name: `${t}, Quoted`, code: c1, type: 'state' })
    expect(rows).toContainEqual({ name: `${t} Spaced`, code: c2, type: 'union_territory' })
  })

  it('rejects the whole file with a row-level error list and saves nothing when any row is bad', async () => {
    const t = tag()
    const csv = [
      header,
      `${home.iso2},${t} Good,${nextCode()},state`, // row 2: fine
      `${home.iso2},A,${nextCode()},state`, // row 3: name too short
      `${home.iso2},${t} BadCode,TOOLONG,state`, // row 4: code too long
      `${home.iso2},${t} BadType,${nextCode()},republic`, // row 5: unknown type
      `ZZ,${t} NoLand,${nextCode()},state`, // row 6: no such country
      `${dormant.iso2},${t} Dormant,${nextCode()},state`, // row 7: inactive country
      `${home.iso2},${t} Short`, // row 8: missing columns
    ].join('\n')
    const res = await importCsv(superAdmin, csv)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Fix the rows below. Nothing was imported.' })
    const problems = res.body.error.details as { row: number; path?: string; message: string }[]
    expect(problems.map((p) => p.row)).toEqual([3, 4, 5, 6, 7, 8])
    expect(problems).toContainEqual({ row: 3, path: 'name', message: 'State name must be 2–60 characters.' })
    expect(problems).toContainEqual({ row: 4, path: 'code', message: 'Code uses 1–5 capital letters or digits.' })
    expect(problems).toContainEqual({ row: 5, path: 'type', message: 'Pick a value from the list.' })
    expect(problems).toContainEqual({ row: 6, path: 'country_iso2', message: 'No country with ISO code ZZ.' })
    expect(problems).toContainEqual({ row: 7, path: 'country_iso2', message: `${dormant.iso2} is not an active country.` })
    expect(problems).toContainEqual({ row: 8, message: 'Expected 4 columns but found 2.' })
    expect((await names(home.iso2)).some((n) => n.startsWith(t))).toBe(false) // even the good row was not saved
  })

  it('reports rows that repeat a name or code from earlier in the same file', async () => {
    const t = tag()
    const code = nextCode()
    const res = await importCsv(superAdmin, `${header}\n${home.iso2},${t} A,${code},state\n${home.iso2},${t} a,${nextCode()},state\n${home.iso2},${t} B,${code},state\n${other.iso2},${t} A,${code},state\n`)
    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual([
      { row: 3, path: 'name', message: 'Same country and name as row 2.' },
      { row: 4, path: 'code', message: 'Same country and code as row 2.' },
    ])
  })

  it.each([
    ['an empty file', '', 'The file is empty.', undefined],
    ['a file with only a header', 'country_iso2,name,code,type\n', 'The file has a header but no rows.', undefined],
    ['a wrong header', 'iso,name,code\nIN,Goa,GA\n', 'The first row must be the header: country_iso2,name,code,type', 1],
    ['a header in the wrong order', 'name,country_iso2,code,type\nGoa,IN,GA,state\n', 'The first row must be the header: country_iso2,name,code,type', 1],
  ])('rejects %s', async (_label, csv, message, row) => {
    const res = await importCsv(superAdmin, csv)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toEqual([row ? { row, message } : { message }])
  })

  it('accepts exactly 500 rows and rejects 501', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `${home.iso2},Bulk ${RUN} ${i},B${i.toString(36).toUpperCase()},state`).join('\n')
    const ok = await importCsv(superAdmin, `${header}\n${rows(500)}\n`, '?dryRun=true')
    expect(ok.status).toBe(200)
    expect(ok.body.data.created).toHaveLength(500)
    const tooMany = await importCsv(superAdmin, `${header}\n${rows(501)}\n`, '?dryRun=true')
    expect(tooMany.status).toBe(422)
    expect(tooMany.body.error.details).toEqual([{ message: 'Up to 500 rows per file; this one has 501.' }])
  })

  it('needs a text/csv body', async () => {
    const res = await send('post', superAdmin, '/states/import', { csv: 'x' })
    expect(res.status).toBe(415)
    expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED')
  })

  it('rejects an invalid dryRun value', async () => {
    expect((await importCsv(superAdmin, `${header}\n`, '?dryRun=maybe')).status).toBe(422)
  })

  it('lets an operations admin import', async () => {
    const res = await importCsv(ops, `${header}\n${home.iso2},${tag()} Ops,${nextCode()},state\n`)
    expect(res.status).toBe(200)
    expect(res.body.data.created).toHaveLength(1)
  })

  it('answers 401 without a token', async () => {
    expect((await request(app).post(`${API}/states/import`).set('Content-Type', 'text/csv').send(header)).status).toBe(401)
  })
})
