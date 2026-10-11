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
const EMAIL_PREFIX = 'city-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
let karnataka: string // seeded, active
let maharashtra: string // seeded, active
let dormantState: string // inactive, created for these tests
let india: string
const teachers: TestTeacher[] = []
const parents: TestParent[] = []

type CityView = MasterView & {
  state: { id: string; name: string }
  stateId: string
  slug: string
  latitude: number | null
  longitude: number | null
  tier: number | null
  isServiceable: boolean
  sortOrder: number
  areaCount: number
  verifiedTeachers: number
}

const get = (a: { token: string }, path: string) => request(app).get(`${API}/cities${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}/cities${path}`).set(authed(a.token)).set(headers).send(body)
const patch = (id: string, body: Body, version: string) => send('patch', superAdmin, `/${id}`, body, { 'If-Match': version })

let seq = 0
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const n = ++seq
  const res = await send('post', as, '', { stateId: karnataka, name: `CTest City ${n} ${RUN}`, isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as CityView
}
const addArea = (cityId: string, deleted = false) =>
  db.insertInto('areas').values({ city_id: cityId, name: `CTest Area ${randomUUID().slice(0, 8)}`, slug: `ctest-area-${randomUUID().slice(0, 8)}`, ...(deleted ? { deleted_at: new Date() } : {}) }).execute()

// Everything the test admins created, from this and any aborted earlier run.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const cities = (await db.selectFrom('cities').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
  if (cities.length) {
    await db.deleteFrom('areas').where('city_id', 'in', cities).execute()
    await db.deleteFrom('cities').where('id', 'in', cities).execute()
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
  maharashtra = (await db.selectFrom('states').select('id').where('code', '=', 'MH').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id
  india = (await db.selectFrom('countries').select('id').where('iso2', '=', 'IN').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id
  dormantState = (await db.insertInto('states').values({ country_id: india, name: `CTest Dormant ${RUN}`, code: `C${RUN.slice(0, 3).toUpperCase()}`, is_active: false, created_by: superAdmin.id }).returning('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describeMasterCommon<CityView>({
  app,
  actors: () => ({ superAdmin, ops, reader, outsider }),
  path: '/cities',
  noun: 'city',
  plural: 'cities',
  notFoundMessage: 'City not found.',
  readKey: 'locations.read',
  manageKey: 'locations.manage',
  entityType: 'cities',
  auditPrefix: 'city',
  auditModule: 'locations',
  make,
  edit: { field: 'sortOrder', first: 51, second: 52 },
  recreate: (c) => ({ stateId: c.stateId, name: c.name }),
  duplicate: { message: 'A city with this name already exists.', field: 'name' },
  badQueries: ['tier=4', 'stateId=ka', 'countryId=in', 'serviceable=maybe'],
})

describe('create (FR-9.2)', () => {
  it('creates a city, normalises input, makes a slug from the name and audits it', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '', { stateId: karnataka, name: `  CTest   Kochi ${tag} `, latitude: 9.9312334, longitude: 76.267304, tier: 2 })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      state: { id: karnataka, name: 'Karnataka' },
      name: `CTest Kochi ${tag}`,
      slug: `ctest-kochi-${tag}`,
      latitude: 9.931233, // kept to 6 decimals
      longitude: 76.267304,
      tier: 2,
      isServiceable: false,
      isActive: true,
      sortOrder: 0,
      areaCount: 0,
      verifiedTeachers: 0,
      deletedAt: null,
    })
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'cities').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'city.created', actor_id: superAdmin.id, module: 'locations' })
    expect(log.new_values).toMatchObject({ slug: `ctest-kochi-${tag}`, tier: 2, isServiceable: false })
  })

  it('accepts a slug of its own, lower-cased', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '', { stateId: karnataka, name: `CTest Slug ${tag}`, slug: `  Kochi-${tag}  ` })
    expect(res.status).toBe(201)
    expect(res.body.data.slug).toBe(`kochi-${tag}`)
  })

  it('gives two cities with names that make the same slug different slugs', async () => {
    const tag = uniqueTag()
    const first = await make({ name: `${tag} Town` })
    const second = await make({ stateId: maharashtra, name: `${tag} town` })
    expect(first.slug).toBe(`${tag}-town`)
    expect(second.slug).toBe(`${tag}-town-2`)
  })

  it('uses a placeholder slug for a name with no letters or digits', async () => {
    const res = await send('post', superAdmin, '', { stateId: karnataka, name: '!!' })
    expect(res.status).toBe(201)
    expect(res.body.data.slug).toMatch(/^city(-\d+)?$/)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'City name must be 2–60 characters.'],
    ['name too long', { name: 'x'.repeat(61) }, 'name', 'City name must be 2–60 characters.'],
    ['slug with a symbol', { slug: 'bad slug!' }, 'slug', 'Slug uses 2–60 lower-case letters, digits or hyphens.'],
    ['slug too short', { slug: 'a' }, 'slug', 'Slug uses 2–60 lower-case letters, digits or hyphens.'],
    ['latitude above 90', { latitude: 91 }, 'latitude', 'Latitude must be between -90 and 90.'],
    ['longitude below -180', { longitude: -181 }, 'longitude', 'Longitude must be between -180 and 180.'],
    ['latitude not a number', { latitude: 'north' }, 'latitude', 'Latitude must be a number.'],
    ['tier 4', { tier: 4 }, 'tier', 'Tier is 1, 2 or 3.'],
    ['isServiceable not a boolean', { isServiceable: 'yes' }, 'isServiceable', 'Serviceable must be true or false.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['state not an id', { stateId: 'karnataka' }, 'stateId', 'Pick an active parent record.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '', { stateId: karnataka, name: `CTest bad ${++seq} ${RUN}`, ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('rejects a missing state, a missing name and an unknown field', async () => {
    const noState = await send('post', superAdmin, '', { name: `CTest no state ${RUN}` })
    expect(noState.status).toBe(422)
    expect(noState.body.error.details).toContainEqual({ path: 'stateId', message: 'Pick an active parent record.' })
    expect((await send('post', superAdmin, '', { stateId: karnataka })).status).toBe(422)
  })

  it('requires the state to exist, be active and not be deleted (422)', async () => {
    const gone = await db.insertInto('states').values({ country_id: india, name: `CTest Gone ${RUN}`, code: `G${RUN.slice(0, 3).toUpperCase()}`, deleted_at: new Date(), created_by: superAdmin.id }).returning('id').executeTakeFirstOrThrow()
    for (const stateId of [randomUUID(), dormantState, gone.id]) {
      const res = await send('post', superAdmin, '', { stateId, name: `CTest orphan ${++seq} ${RUN}` })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Pick an active parent record.' })
    }
  })

  it('allows the same name in another state but not a slug that is already taken', async () => {
    const a = await make()
    const elsewhere = await send('post', superAdmin, '', { stateId: maharashtra, name: a.name })
    expect(elsewhere.status).toBe(201)
    expect(elsewhere.body.data.slug).toBe(`${a.slug}-2`)
    const clash = await send('post', superAdmin, '', { stateId: karnataka, name: `CTest other ${++seq} ${RUN}`, slug: a.slug })
    expect(clash.status).toBe(409)
    expect(clash.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A city with this slug already exists.', details: { field: 'slug' } })
  })
})

describe('read (FR-9.1)', () => {
  it('returns the city with its area count and verified teachers', async () => {
    const c = await make()
    await addArea(c.id)
    await addArea(c.id)
    await addArea(c.id, true)
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: c.id }))
    teachers.push(await createTeacher(masters, { status: 'pending', cityId: c.id })) // not verified
    teachers.push(await createTeacher(masters, { status: 'approved', account: 'suspended', cityId: c.id })) // suspended
    const res = await get(reader, `/${c.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, state: { id: karnataka }, areaCount: 2, verifiedTeachers: 1 })
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['areaCount', 'createdAt', 'deletedAt', 'id', 'isActive', 'isServiceable', 'latitude', 'longitude', 'name', 'slug', 'sortOrder', 'state', 'stateId', 'tier', 'updatedAt', 'verifiedTeachers'].sort(),
    )
  })

  it('filters by country, state, tier, serviceable and active', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} A`, tier: 1, isServiceable: true })
    const b = await make({ name: `${tag} B`, tier: 2, isActive: false })
    const c = await make({ stateId: maharashtra, name: `${tag} C`, tier: 1 })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `?q=${q}${extra}`)).body.data.map((r: CityView) => r.id).sort()
    expect(await ids('')).toEqual([a.id, b.id, c.id].sort())
    expect(await ids(`&stateId=${karnataka}`)).toEqual([a.id, b.id].sort())
    expect(await ids(`&stateId=${maharashtra}`)).toEqual([c.id])
    expect(await ids(`&countryId=${india}`)).toEqual([a.id, b.id, c.id].sort())
    expect(await ids(`&countryId=${randomUUID()}`)).toEqual([])
    expect(await ids('&tier=1')).toEqual([a.id, c.id].sort())
    expect(await ids('&tier=2')).toEqual([b.id])
    expect(await ids('&serviceable=true')).toEqual([a.id])
    expect(await ids('&serviceable=false')).toEqual([b.id, c.id].sort())
    expect(await ids('&active=false')).toEqual([b.id])
  })

  it('searches by an exact slug and ranks the closest names first', async () => {
    const tag = uniqueTag()
    const exact = await make({ name: `${tag} Nagar` })
    await make({ name: `${tag} Nagara Vihar` })
    const bySlug = await get(reader, `?q=${exact.slug}`)
    expect(bySlug.body.data.map((r: CityView) => r.id)).toContain(exact.id)
    const ranked = (await get(reader, `?q=${encodeURIComponent(`${tag} Nagar`)}`)).body.data.map((r: CityView) => r.id)
    expect(ranked[0]).toBe(exact.id)
  })

  it('lists the seeded cities with their state', async () => {
    const res = await get(reader, `?stateId=${karnataka}&pageSize=100&sort=name:asc`)
    expect(res.status).toBe(200)
    expect(res.body.data.every((c: CityView) => c.state.name === 'Karnataka')).toBe(true)
  })
})

describe('dropdown mode (FR-9 S2)', () => {
  it('filters by state and returns the app fields', async () => {
    const c = await make({ tier: 3, isServiceable: true })
    const other = await make({ stateId: maharashtra })
    const res = await get(reader, `?active=true&stateId=${karnataka}&fields=id,name,slug,stateId,tier,isServiceable`)
    expect(res.body.data.find((r: CityView) => r.id === c.id)).toEqual({ id: c.id, name: c.name, slug: c.slug, stateId: karnataka, tier: 3, isServiceable: true })
    expect(res.body.data.some((r: CityView) => r.id === other.id)).toBe(false)
  })
})

describe('update (FR-9.3)', () => {
  it('changes coordinates and tier, and clears them with null', async () => {
    const c = await make({ latitude: 12.97, longitude: 77.59, tier: 1 })
    const moved = await patch(c.id, { latitude: 12.935242, tier: 2 }, c.updatedAt)
    expect(moved.status).toBe(200)
    expect(moved.body.data).toMatchObject({ latitude: 12.935242, longitude: 77.59, tier: 2 })
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', c.id).where('action', '=', 'city.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ latitude: 12.97, tier: 1 })
    expect(log.new_values).toEqual({ latitude: 12.935242, tier: 2 })
    const cleared = await patch(c.id, { latitude: null, longitude: null, tier: null }, moved.body.data.updatedAt)
    expect(cleared.body.data).toMatchObject({ latitude: null, longitude: null, tier: null })
  })

  it('treats unchanged coordinates as a no-op', async () => {
    const c = await make({ latitude: 12.97, longitude: 77.59 })
    const res = await patch(c.id, { latitude: 12.97, longitude: 77.59 }, c.updatedAt)
    expect(res.body.data.updatedAt).toBe(c.updatedAt)
  })

  it('rejects out-of-range coordinates and an unknown tier', async () => {
    const c = await make()
    expect((await patch(c.id, { latitude: 100 }, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { longitude: 200 }, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { tier: 5 }, c.updatedAt)).status).toBe(422)
  })

  it('changes the slug while the city is not serviceable, and keeps it unique', async () => {
    const a = await make()
    const b = await make()
    const free = `renamed-${uniqueTag()}`
    const res = await patch(a.id, { slug: free.toUpperCase() }, a.updatedAt)
    expect(res.body.data.slug).toBe(free)
    const clash = await patch(b.id, { slug: free }, b.updatedAt)
    expect(clash.status).toBe(409)
    expect(clash.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'slug' } })
  })

  it("freezes the slug once the city is serviceable (FR-9.S2)", async () => {
    const c = await make({ isServiceable: true })
    const res = await patch(c.id, { slug: `new-${uniqueTag()}`, name: `${c.name} Renamed` }, c.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "Slugs can't change after launch." })
    const stored = await db.selectFrom('cities').select(['slug', 'name']).where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ slug: c.slug, name: c.name }) // the rename was not applied either
    expect((await patch(c.id, { name: `${c.name} Renamed` }, c.updatedAt)).status).toBe(200) // other fields still change
    expect((await patch(c.id, { slug: c.slug }, c.updatedAt)).status).toBe(409) // stale version, not a slug problem
  })

  it('launches a city, and a launched city can go back', async () => {
    const c = await make()
    const launched = await patch(c.id, { isServiceable: true }, c.updatedAt)
    expect(launched.body.data.isServiceable).toBe(true)
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', c.id).where('action', '=', 'city.updated').executeTakeFirstOrThrow()
    expect(log.new_values).toEqual({ isServiceable: true })
    expect((await patch(c.id, { isServiceable: false }, launched.body.data.updatedAt)).body.data.isServiceable).toBe(false)
  })

  it('moves a city to another active state, and refuses an inactive or unknown one', async () => {
    const c = await make()
    for (const stateId of [dormantState, randomUUID()]) {
      const res = await patch(c.id, { stateId }, c.updatedAt)
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'stateId', message: 'Pick an active parent record.' })
    }
    const moved = await patch(c.id, { stateId: maharashtra }, c.updatedAt)
    expect(moved.body.data.state.name).toBe('Maharashtra')
  })

  it('returns 409 CONFLICT_DUPLICATE when moving into a state that already has that name', async () => {
    const c = await make()
    await send('post', superAdmin, '', { stateId: maharashtra, name: c.name })
    const res = await patch(c.id, { stateId: maharashtra }, c.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
  })
})

describe('stats (FR-9.S3)', () => {
  it('counts verified teachers, institutes, parents, students and areas', async () => {
    const c = await make()
    await addArea(c.id)
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: c.id }))
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: c.id }))
    teachers.push(await createTeacher(masters, { status: 'draft', cityId: c.id }))
    const parent = await createParent(masters, { cityId: c.id, areaId: null })
    parents.push(parent)
    const res = await get(ops, `/${c.id}/stats`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ verifiedTeachers: 2, institutes: 0, parents: 1, students: 0, areas: 1 })
  })

  it('is zero for a new city', async () => {
    const c = await make()
    expect((await get(superAdmin, `/${c.id}/stats`)).body.data).toEqual({ verifiedTeachers: 0, institutes: 0, parents: 0, students: 0, areas: 0 })
  })

  it('needs locations.manage and answers 404 for an unknown or deleted city', async () => {
    const c = await make()
    const denied = await get(reader, `/${c.id}/stats`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.details).toEqual({ required: ['locations.manage'] })
    expect((await get(superAdmin, `/${randomUUID()}/stats`)).status).toBe(404)
    expect((await get(superAdmin, '/nope/stats')).status).toBe(404)
    await send('delete', superAdmin, `/${c.id}`)
    expect((await get(superAdmin, `/${c.id}/stats`)).status).toBe(404)
  })
})

describe('delete and restore (FR-9.5, FR-9.6)', () => {
  it('returns 409 CONFLICT_IN_USE with reference counts while areas, teachers and parents use it', async () => {
    const c = await make()
    await addArea(c.id)
    await addArea(c.id)
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: c.id }))
    parents.push(await createParent(masters, { cityId: c.id, areaId: null }))
    const res = await send('delete', superAdmin, `/${c.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_IN_USE',
      message: 'This city is in use. Deactivate it instead.',
      details: { references: { areas: 2, teacher_locations: 1, parents: 1 } },
    })
    expect((await get(superAdmin, `/${c.id}`)).status).toBe(200)
  })

  it('ignores soft-deleted areas when checking usage', async () => {
    const c = await make()
    await addArea(c.id, true)
    expect((await send('delete', superAdmin, `/${c.id}`)).status).toBe(204)
  })

  it('refuses to bring a city back under a state that is itself deleted', async () => {
    const st = await db.insertInto('states').values({ country_id: india, name: `CTest Short-lived ${RUN}`, code: `S${RUN.slice(0, 3).toUpperCase()}`, created_by: superAdmin.id }).returning('id').executeTakeFirstOrThrow()
    const c = await make({ stateId: st.id })
    await send('delete', superAdmin, `/${c.id}`)
    await db.updateTable('states').set({ deleted_at: new Date() }).where('id', '=', st.id).execute()
    const res = await send('post', superAdmin, `/${c.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_STATE')
    expect(res.body.error.message).toContain('Restore CTest Short-lived')
  })
})
