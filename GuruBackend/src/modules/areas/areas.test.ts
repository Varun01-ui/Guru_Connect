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
const EMAIL_PREFIX = 'area-test'
const RUN = randomUUID().replace(/-/g, '').slice(0, 6)

let superAdmin: TestAdmin
let ops: TestAdmin
let reader: TestAdmin
let outsider: TestAdmin
let masters: Masters
let home: { id: string; slug: string } // the city most fixtures live in
let sibling: { id: string; slug: string } // a second active city
let dormant: { id: string; slug: string } // an inactive city
const teachers: TestTeacher[] = []
const parents: TestParent[] = []

type AreaView = MasterView & {
  city: { id: string; name: string }
  cityId: string
  slug: string
  pincodes: string[]
  latitude: number | null
  longitude: number | null
  sortOrder: number
  teacherCount: number
}

const get = (a: { token: string }, path: string) => request(app).get(`${API}/areas${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}/areas${path}`).set(authed(a.token)).set(headers).send(body)
const patch = (id: string, body: Body, version: string) => send('patch', superAdmin, `/${id}`, body, { 'If-Match': version })
const importCsv = (a: { token: string }, csv: string, query = '') => request(app).post(`${API}/areas/import${query}`).set(authed(a.token)).set('Content-Type', 'text/csv').send(csv)
const merge = (id: string, body: Body, as: { token: string } = superAdmin) => send('post', as, `/${id}/merge`, body)

let seq = 0
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const res = await send('post', as, '', { cityId: home.id, name: `CTest Area ${++seq} ${RUN}`, isActive: true, sortOrder: 50, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as AreaView
}
let citySeq = 0
async function makeCity(isActive = true) {
  const name = `CTest Metro ${++citySeq} ${RUN}`
  const res = await request(app).post(`${API}/cities`).set(authed(superAdmin.token)).send({ stateId: karnataka, name, isActive })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { id: res.body.data.id as string, slug: res.body.data.slug as string }
}
let karnataka: string
const pin = () => String(500000 + Math.floor(Math.random() * 499999))

// Everything the test admins created, from this and any aborted earlier run.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const cities = (await db.selectFrom('cities').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
  if (cities.length) {
    await db.deleteFrom('areas').where('city_id', 'in', cities).execute()
    await db.deleteFrom('cities').where('id', 'in', cities).execute()
  }
  await db.deleteFrom('areas').where('created_by', 'in', admins).execute()
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  masters = await loadMasters()
  karnataka = (await db.selectFrom('states').select('id').where('code', '=', 'KA').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id
  home = await makeCity()
  sibling = await makeCity()
  dormant = await makeCity(false)
})

afterAll(async () => {
  await purgeUsersByPhone(teachers.map((t) => t.phone))
  for (const p of parents) await deleteParent(p)
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describeMasterCommon<AreaView>({
  app,
  actors: () => ({ superAdmin, ops, reader, outsider }),
  path: '/areas',
  noun: 'area',
  plural: 'areas',
  notFoundMessage: 'Area not found.',
  readKey: 'locations.read',
  manageKey: 'locations.manage',
  entityType: 'areas',
  auditPrefix: 'area',
  auditModule: 'locations',
  make,
  edit: { field: 'sortOrder', first: 51, second: 52 },
  recreate: (a) => ({ cityId: a.cityId, name: a.name }),
  duplicate: { message: 'An area with this name already exists.', field: 'name' },
  badQueries: ['cityId=bengaluru', 'hasCoordinates=maybe'],
})

describe('create (FR-10.2)', () => {
  it('creates an area, normalises input, makes a slug and audits it', async () => {
    const tag = uniqueTag()
    const res = await send('post', superAdmin, '', { cityId: home.id, name: `  CTest   Koramangala ${tag} `, pincodes: [' 560095 ', '560034'], latitude: 12.9352421, longitude: 77.62448 })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      city: { id: home.id },
      name: `CTest Koramangala ${tag}`,
      slug: `ctest-koramangala-${tag}`,
      pincodes: ['560034', '560095'], // sorted
      latitude: 12.935242,
      longitude: 77.62448,
      isActive: true,
      sortOrder: 0,
      teacherCount: 0,
      deletedAt: null,
    })
    expect(res.body.data.city.name).toContain('CTest Metro')
    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'areas').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'area.created', actor_id: superAdmin.id, module: 'locations' })
    expect(log.new_values).toMatchObject({ pincodes: ['560034', '560095'] })
  })

  it('defaults to no PIN codes and no coordinates', async () => {
    const a = await make()
    expect(a).toMatchObject({ pincodes: [], latitude: null, longitude: null })
  })

  it('gives areas whose names make the same slug different slugs within a city, and reuses a slug across cities', async () => {
    const tag = uniqueTag()
    const first = await make({ name: `${tag} Nagar` })
    const second = await make({ name: `${tag} nagar!` })
    const elsewhere = await make({ cityId: sibling.id, name: `${tag} Nagar` })
    expect(first.slug).toBe(`${tag}-nagar`)
    expect(second.slug).toBe(`${tag}-nagar-2`)
    expect(elsewhere.slug).toBe(`${tag}-nagar`)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name', 'Area name must be 2–80 characters.'],
    ['name too long', { name: 'x'.repeat(81) }, 'name', 'Area name must be 2–80 characters.'],
    ['PIN code with 5 digits', { pincodes: ['56003'] }, 'pincodes.0', 'A PIN code is 6 digits and does not start with 0.'],
    ['PIN code starting with 0', { pincodes: ['012345'] }, 'pincodes.0', 'A PIN code is 6 digits and does not start with 0.'],
    ['PIN code with letters', { pincodes: ['56O034'] }, 'pincodes.0', 'A PIN code is 6 digits and does not start with 0.'],
    ['repeated PIN code', { pincodes: ['560034', '560034'] }, 'pincodes', 'Each PIN code can only be listed once.'],
    ['21 PIN codes', { pincodes: Array.from({ length: 21 }, (_, i) => String(560000 + i)) }, 'pincodes', 'An area can have up to 20 PIN codes.'],
    ['pincodes not a list', { pincodes: '560034' }, 'pincodes', 'PIN codes must be a list.'],
    ['latitude above 90', { latitude: 91 }, 'latitude', 'Latitude must be between -90 and 90.'],
    ['longitude below -180', { longitude: -181 }, 'longitude', 'Longitude must be between -180 and 180.'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive', 'Active must be true or false.'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder', 'Order must be 0–9,999.'],
    ['city not an id', { cityId: 'bengaluru' }, 'cityId', 'Pick an active parent record.'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field, message) => {
    const res = await send('post', superAdmin, '', { cityId: home.id, name: `CTest bad ${++seq} ${RUN}`, ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toContainEqual({ path: field, message })
  })

  it('accepts exactly 20 PIN codes', async () => {
    const a = await make({ pincodes: Array.from({ length: 20 }, (_, i) => String(570000 + i)) })
    expect(a.pincodes).toHaveLength(20)
  })

  it('requires the city to exist, be active and not be deleted (422)', async () => {
    const gone = await makeCity()
    expect((await request(app).delete(`${API}/cities/${gone.id}`).set(authed(superAdmin.token))).status).toBe(204)
    for (const cityId of [randomUUID(), dormant.id, gone.id]) {
      const res = await send('post', superAdmin, '', { cityId, name: `CTest orphan ${++seq} ${RUN}` })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Pick an active parent record.' })
    }
  })

  it('allows the same name in another city but not twice in one', async () => {
    const a = await make()
    expect((await send('post', superAdmin, '', { cityId: sibling.id, name: a.name })).status).toBe(201)
    expect((await send('post', superAdmin, '', { cityId: home.id, name: a.name.toUpperCase() })).status).toBe(409)
  })
})

describe('read (FR-10.1)', () => {
  it('returns the area with its city and teacher count', async () => {
    const a = await make()
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: a.id }))
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: a.id }))
    const res = await get(reader, `/${a.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: a.id, city: { id: home.id }, teacherCount: 2 })
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['city', 'cityId', 'createdAt', 'deletedAt', 'id', 'isActive', 'latitude', 'longitude', 'name', 'pincodes', 'slug', 'sortOrder', 'teacherCount', 'updatedAt'].sort(),
    )
  })

  it('filters by city and by whether it has coordinates', async () => {
    const tag = uniqueTag()
    const located = await make({ name: `${tag} A`, latitude: 12.9, longitude: 77.6 })
    const half = await make({ name: `${tag} B`, latitude: 12.9 })
    const bare = await make({ name: `${tag} C` })
    const elsewhere = await make({ cityId: sibling.id, name: `${tag} D` })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `?q=${q}${extra}`)).body.data.map((r: AreaView) => r.id).sort()
    expect(await ids('')).toEqual([located.id, half.id, bare.id, elsewhere.id].sort())
    expect(await ids(`&cityId=${home.id}`)).toEqual([located.id, half.id, bare.id].sort())
    expect(await ids(`&cityId=${sibling.id}`)).toEqual([elsewhere.id])
    expect(await ids('&hasCoordinates=true')).toEqual([located.id])
    expect(await ids('&hasCoordinates=false')).toEqual([half.id, bare.id, elsewhere.id].sort())
  })

  it('finds an area by a PIN code it covers, only by the whole code', async () => {
    const code = pin()
    const a = await make({ pincodes: [code, '560001'] })
    await make({ pincodes: ['560001'] })
    expect((await get(reader, `?q=${code}`)).body.data.map((r: AreaView) => r.id)).toEqual([a.id])
    expect((await get(reader, `?q=${code.slice(0, 5)}`)).body.data.map((r: AreaView) => r.id)).not.toContain(a.id)
  })
})

describe('dropdown mode (FR-10 S2)', () => {
  it('filters by city and can include the PIN codes', async () => {
    const a = await make({ pincodes: ['560034'] })
    const other = await make({ cityId: sibling.id })
    const res = await get(reader, `?active=true&cityId=${home.id}&fields=id,name,slug,cityId,pincodes`)
    expect(res.body.data.find((r: AreaView) => r.id === a.id)).toEqual({ id: a.id, name: a.name, slug: a.slug, cityId: home.id, pincodes: ['560034'] })
    expect(res.body.data.some((r: AreaView) => r.id === other.id)).toBe(false)
  })
})

describe('update (FR-10.3)', () => {
  it('changes the PIN codes and audits the difference', async () => {
    const a = await make({ pincodes: ['560034'] })
    const res = await patch(a.id, { pincodes: ['560095', '560034', '560102'] }, a.updatedAt)
    expect(res.body.data.pincodes).toEqual(['560034', '560095', '560102'])
    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', a.id).where('action', '=', 'area.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ pincodes: ['560034'] })
    expect(log.new_values).toEqual({ pincodes: ['560034', '560095', '560102'] })
  })

  it('treats the same PIN codes in another order as no change', async () => {
    const a = await make({ pincodes: ['560034', '560095'] })
    const res = await patch(a.id, { pincodes: ['560095', '560034'] }, a.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(a.updatedAt)
  })

  it('validates PIN codes on update and clears them with an empty list', async () => {
    const a = await make({ pincodes: ['560034'] })
    expect((await patch(a.id, { pincodes: ['12'] }, a.updatedAt)).status).toBe(422)
    expect((await patch(a.id, { pincodes: [] }, a.updatedAt)).body.data.pincodes).toEqual([])
  })

  it('sets and clears coordinates', async () => {
    const a = await make()
    const set = await patch(a.id, { latitude: 12.935242, longitude: 77.62448 }, a.updatedAt)
    expect(set.body.data).toMatchObject({ latitude: 12.935242, longitude: 77.62448 })
    const cleared = await patch(a.id, { latitude: null, longitude: null }, set.body.data.updatedAt)
    expect(cleared.body.data).toMatchObject({ latitude: null, longitude: null })
    expect((await patch(a.id, { latitude: 100 }, cleared.body.data.updatedAt)).status).toBe(422)
  })

  it('moves an area to another active city, and refuses an inactive or unknown one', async () => {
    const a = await make()
    for (const cityId of [dormant.id, randomUUID()]) {
      const res = await patch(a.id, { cityId }, a.updatedAt)
      expect(res.status).toBe(422)
      expect(res.body.error.details).toContainEqual({ path: 'cityId', message: 'Pick an active parent record.' })
    }
    expect((await patch(a.id, { cityId: sibling.id }, a.updatedAt)).body.data.city.id).toBe(sibling.id)
  })

  it('does not let the slug be edited', async () => {
    const a = await make()
    expect((await patch(a.id, { slug: 'new-slug' }, a.updatedAt)).status).toBe(422)
  })
})

describe('PIN lookup (FR-10.S3)', () => {
  it('lists the areas, across cities, that contain a PIN code', async () => {
    const code = pin()
    const a = await make({ pincodes: [code] })
    const b = await make({ cityId: sibling.id, pincodes: [code, '560001'] })
    await make({ pincodes: ['560001'] })
    const gone = await make({ pincodes: [code] })
    await send('delete', superAdmin, `/${gone.id}`)

    const res = await get(ops, `/by-pincode/${code}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: { id: string }) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(res.body.data.find((r: { id: string }) => r.id === b.id)).toMatchObject({ name: b.name, slug: b.slug, pincodes: [code, '560001'].sort(), isActive: true, city: { id: sibling.id } })
  })

  it('returns an empty list for a PIN nobody covers', async () => {
    expect((await get(ops, '/by-pincode/999999')).body.data).toEqual([])
  })

  it.each(['12345', '012345', 'abcdef', '1234567'])('rejects %s with 422', async (bad) => {
    const res = await get(ops, `/by-pincode/${bad}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('needs locations.manage', async () => {
    expect((await get(reader, '/by-pincode/560034')).status).toBe(403)
    expect((await request(app).get(`${API}/areas/by-pincode/560034`)).status).toBe(401)
  })
})

describe('CSV import (FR-10.S1)', () => {
  const header = 'city_slug,name,pincodes,latitude,longitude'
  const tag = () => `Imp${uniqueTag()}`
  const namesIn = async (cityId: string) => (await db.selectFrom('areas').select('name').where('city_id', '=', cityId).where('deleted_at', 'is', null).execute()).map((r) => r.name)

  it('checks the file without saving anything when dryRun is set', async () => {
    const t = tag()
    const before = (await db.selectFrom('audit_logs').select('id').where('action', '=', 'area.imported').execute()).length
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${t} One,560034 560095,12.9,77.6\n${home.slug},${t} Two,,,\n`, '?dryRun=true')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ dryRun: true, total: 2, skipped: [] })
    expect(res.body.data.created.map((c: { row: number }) => c.row)).toEqual([2, 3])
    expect((await namesIn(home.id)).some((n) => n.startsWith(t))).toBe(false)
    expect((await db.selectFrom('audit_logs').select('id').where('action', '=', 'area.imported').execute()).length).toBe(before)
  })

  it('creates every row, reading PIN codes in any separator, and records one audit entry', async () => {
    const t = tag()
    const csv = [header, `${home.slug},${t} One,560034 560095,12.9352421,77.62448`, `${sibling.slug},${t} Two,"560001,560002",,`, `${home.slug},${t} Three,560003|560004;560005,,`].join('\r\n')
    const res = await importCsv(superAdmin, csv)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ dryRun: false, total: 3, skipped: [] })
    const rows = await db.selectFrom('areas').select(['name', 'slug', 'pincodes', 'latitude', 'city_id', 'created_by']).where('name', 'like', `${t}%`).execute()
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName[`${t} One`]).toMatchObject({ pincodes: ['560034', '560095'], latitude: '12.935242', city_id: home.id, created_by: superAdmin.id })
    expect(byName[`${t} Two`]).toMatchObject({ pincodes: ['560001', '560002'], city_id: sibling.id, latitude: null })
    expect(byName[`${t} Three`]!.pincodes).toEqual(['560003', '560004', '560005'])
    const log = await db.selectFrom('audit_logs').select(['module', 'actor_id', 'new_values']).where('action', '=', 'area.imported').orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ module: 'locations', actor_id: superAdmin.id })
    expect((log.new_values as { created: unknown[] }).created).toHaveLength(3)
  })

  it('gives areas created in one file distinct slugs', async () => {
    const t = tag()
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${t} Layout,,,\n${home.slug},${t} layout 2,,,\n`)
    expect(res.status).toBe(200)
    const slugs = (await db.selectFrom('areas').select('slug').where('name', 'like', `${t}%`).execute()).map((r) => r.slug).sort()
    expect(new Set(slugs).size).toBe(2)
  })

  it('skips areas that already exist and imports the rest', async () => {
    const existing = await make()
    const t = tag()
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${existing.name.toUpperCase()},,,\n${home.slug},${t} Fresh,,,\n`)
    expect(res.status).toBe(200)
    expect(res.body.data.created).toEqual([{ row: 3, label: `${t} Fresh` }])
    expect(res.body.data.skipped).toEqual([{ row: 2, label: existing.name.toUpperCase(), reason: 'An area with this name already exists.' }])
  })

  it('rejects the whole file with row-level errors, saving nothing, when any row is bad', async () => {
    const t = tag()
    const csv = [
      header,
      `${home.slug},${t} Good,560034,,`, // row 2
      `${home.slug},A,,,`, // row 3: name too short
      `${home.slug},${t} BadPin,12345,,`, // row 4
      `${home.slug},${t} BadLat,,95,`, // row 5
      `no-such-city,${t} NoCity,,,`, // row 6
      `${dormant.slug},${t} Dormant,,,`, // row 7
      `${home.slug},${t} Short`, // row 8: missing columns
    ].join('\n')
    const res = await importCsv(superAdmin, csv)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Fix the rows below. Nothing was imported.' })
    const problems = res.body.error.details as { row: number; path?: string; message: string }[]
    expect(problems.map((p) => p.row)).toEqual([3, 4, 5, 6, 7, 8])
    expect(problems).toContainEqual({ row: 3, path: 'name', message: 'Area name must be 2–80 characters.' })
    expect(problems).toContainEqual({ row: 4, path: 'pincodes', message: 'A PIN code is 6 digits and does not start with 0.' })
    expect(problems).toContainEqual({ row: 5, path: 'latitude', message: 'Latitude must be between -90 and 90.' })
    expect(problems).toContainEqual({ row: 6, path: 'city_slug', message: 'No city with slug no-such-city.' })
    expect(problems).toContainEqual({ row: 7, path: 'city_slug', message: `${dormant.slug} is not an active city.` })
    expect(problems).toContainEqual({ row: 8, message: 'Expected 5 columns but found 2.' })
    expect((await namesIn(home.id)).some((n) => n.startsWith(t))).toBe(false)
  })

  it('with skipInvalid applies the good rows and reports the bad ones as skipped', async () => {
    const t = tag()
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${t} Good,560034,,\n${home.slug},${t} BadPin,12345,,\nno-such-city,${t} Lost,,,\n`, '?skipInvalid=true')
    expect(res.status).toBe(200)
    expect(res.body.data.created).toEqual([{ row: 2, label: `${t} Good` }])
    expect(res.body.data.skipped).toEqual([
      { row: 3, label: `${t} BadPin`, reason: 'A PIN code is 6 digits and does not start with 0.' },
      { row: 4, label: `${t} Lost`, reason: 'No city with slug no-such-city.' },
    ])
    const names = await namesIn(home.id)
    expect(names).toContain(`${t} Good`)
    expect(names).not.toContain(`${t} BadPin`)
  })

  it('with skipInvalid and dryRun reports without saving', async () => {
    const t = tag()
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${t} Good,,,\n${home.slug},x,,,\n`, '?skipInvalid=true&dryRun=true')
    expect(res.body.data).toMatchObject({ dryRun: true })
    expect(res.body.data.created).toHaveLength(1)
    expect(res.body.data.skipped).toHaveLength(1)
    expect((await namesIn(home.id)).some((n) => n.startsWith(t))).toBe(false)
  })

  it('reports rows that repeat a city and name from earlier in the file', async () => {
    const t = tag()
    const res = await importCsv(superAdmin, `${header}\n${home.slug},${t} A,,,\n${home.slug},${t} a,,,\n`)
    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual([{ row: 3, path: 'name', message: 'Same city and name as row 2.' }])
  })

  it.each([
    ['an empty file', '', 'The file is empty.', undefined],
    ['a file with only a header', 'city_slug,name,pincodes,latitude,longitude\n', 'The file has a header but no rows.', undefined],
    ['a wrong header', 'slug,name\nx,y\n', 'The first row must be the header: city_slug,name,pincodes,latitude,longitude', 1],
  ])('rejects %s, even with skipInvalid', async (_label, csv, message, row) => {
    const res = await importCsv(superAdmin, csv, '?skipInvalid=true')
    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual([row ? { row, message } : { message }])
  })

  it('accepts exactly 2,000 rows and rejects 2,001', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `${home.slug},Bulk ${RUN} ${i},,,`).join('\n')
    const ok = await importCsv(superAdmin, `${header}\n${rows(2000)}\n`, '?dryRun=true')
    expect(ok.status).toBe(200)
    expect(ok.body.data.created).toHaveLength(2000)
    const tooMany = await importCsv(superAdmin, `${header}\n${rows(2001)}\n`, '?dryRun=true')
    expect(tooMany.status).toBe(422)
    expect(tooMany.body.error.details).toEqual([{ message: 'Up to 2000 rows per file; this one has 2001.' }])
  })

  it('needs a text/csv body, locations.manage and a valid query', async () => {
    expect((await send('post', superAdmin, '/import', { csv: 'x' })).status).toBe(415)
    expect((await importCsv(reader, `${header}\n`)).status).toBe(403)
    expect((await importCsv(superAdmin, `${header}\n`, '?dryRun=maybe')).status).toBe(422)
    expect((await request(app).post(`${API}/areas/import`).set('Content-Type', 'text/csv').send(header)).status).toBe(401)
  })
})

describe('merge (FR-10.S2)', () => {
  async function addLocation(teacherId: string, areaId: string, primary = false) {
    await db.insertInto('teacher_locations').values({ id: randomUUID(), teacher_id: teacherId, city_id: home.id, area_id: areaId, is_primary: primary }).execute()
  }
  const locationsOf = async (teacherId: string) => db.selectFrom('teacher_locations').select(['area_id', 'is_primary']).where('teacher_id', '=', teacherId).execute()

  it('moves teachers and parents to the target, unions the PIN codes and removes the source', async () => {
    const source = await make({ pincodes: ['560001', '560002'], latitude: 12.9, longitude: 77.5 })
    const target = await make({ pincodes: ['560002', '560003'] })
    const t1 = await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: source.id })
    teachers.push(t1)
    const parent = await createParent(masters, { cityId: home.id, areaId: source.id })
    parents.push(parent)

    const res = await merge(source.id, { intoAreaId: target.id, reason: 'Duplicate of the same locality' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.area).toMatchObject({ id: target.id, pincodes: ['560001', '560002', '560003'], teacherCount: 1 })
    expect(res.body.data.moved).toEqual({ teacher_locations: 1, parents: 1 })

    expect((await locationsOf(t1.teacherId)).map((l) => l.area_id)).toEqual([target.id])
    expect((await db.selectFrom('parents').select('area_id').where('id', '=', parent.parentId).executeTakeFirstOrThrow()).area_id).toBe(target.id)
    expect((await get(superAdmin, `/${source.id}`)).status).toBe(404)
    const stored = await db.selectFrom('areas').select(['deleted_at', 'deleted_by']).where('id', '=', source.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)

    const log = await db.selectFrom('audit_logs').select(['action', 'reason', 'old_values', 'new_values', 'module']).where('entity_id', '=', source.id).where('action', '=', 'area.merged').executeTakeFirstOrThrow()
    expect(log).toMatchObject({ reason: 'Duplicate of the same locality', module: 'locations' })
    expect(log.new_values).toMatchObject({ intoAreaId: target.id, moved: { teacher_locations: 1, parents: 1 } })
  })

  it('keeps one row for a teacher who covers both areas, and hands over the primary flag', async () => {
    const source = await make()
    const target = await make()
    const both = await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: source.id }) // source is primary
    teachers.push(both)
    await addLocation(both.teacherId, target.id, false)
    const onlyTarget = await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: target.id })
    teachers.push(onlyTarget)

    expect((await merge(source.id, { intoAreaId: target.id })).status).toBe(200)
    expect(await locationsOf(both.teacherId)).toEqual([{ area_id: target.id, is_primary: true }])
    expect(await locationsOf(onlyTarget.teacherId)).toEqual([{ area_id: target.id, is_primary: true }])
  })

  it('leaves the target’s own primary flag alone when only the target had it', async () => {
    const source = await make()
    const target = await make()
    const t = await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: target.id }) // target primary
    teachers.push(t)
    await addLocation(t.teacherId, source.id, false)
    expect((await merge(source.id, { intoAreaId: target.id })).status).toBe(200)
    expect(await locationsOf(t.teacherId)).toEqual([{ area_id: target.id, is_primary: true }])
  })

  it('rejects an area in another city with 422', async () => {
    const source = await make()
    const target = await make({ cityId: sibling.id })
    const res = await merge(source.id, { intoAreaId: target.id })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Both areas must be in the same city.' })
    expect((await get(superAdmin, `/${source.id}`)).status).toBe(200)
  })

  it('rejects merging an area into itself, an unknown or deleted target, and a missing target', async () => {
    const a = await make()
    const gone = await make()
    await send('delete', superAdmin, `/${gone.id}`)
    expect((await merge(a.id, { intoAreaId: a.id })).status).toBe(422)
    for (const intoAreaId of [randomUUID(), gone.id]) {
      const res = await merge(a.id, { intoAreaId })
      expect(res.status).toBe(422)
      expect(res.body.error.message).toBe('Pick the area to merge into.')
    }
    expect((await merge(a.id, {})).status).toBe(422)
    expect((await merge(a.id, { intoAreaId: 'nope' })).status).toBe(422)
  })

  it('refuses a merge that would give the target more than 20 PIN codes', async () => {
    const source = await make({ pincodes: Array.from({ length: 12 }, (_, i) => String(580000 + i)) })
    const target = await make({ pincodes: Array.from({ length: 12 }, (_, i) => String(590000 + i)) })
    const res = await merge(source.id, { intoAreaId: target.id })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toContain('would have 24 PIN codes')
    expect((await get(superAdmin, `/${source.id}`)).status).toBe(200)
  })

  it('answers 404 for an unknown source, and 403 to someone who can only read', async () => {
    const a = await make()
    expect((await merge(randomUUID(), { intoAreaId: a.id })).status).toBe(404)
    expect((await merge('nope', { intoAreaId: a.id })).status).toBe(404)
    const denied = await merge(a.id, { intoAreaId: a.id }, reader)
    expect(denied.status).toBe(403)
  })

  it('lets an operations admin merge', async () => {
    const source = await make()
    const target = await make()
    expect((await merge(source.id, { intoAreaId: target.id }, ops)).status).toBe(200)
  })
})

describe('delete (FR-10.5)', () => {
  it('returns 409 CONFLICT_IN_USE with reference counts while teachers and parents use it', async () => {
    const a = await make()
    teachers.push(await createTeacher(masters, { status: 'approved', cityId: home.id, areaId: a.id }))
    parents.push(await createParent(masters, { cityId: home.id, areaId: a.id }))
    const res = await send('delete', superAdmin, `/${a.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_IN_USE', message: 'This area is in use. Deactivate it instead.', details: { references: { teacher_locations: 1, parents: 1 } } })
  })

  it('refuses to bring an area back under a city that is itself deleted', async () => {
    const city = await makeCity()
    const a = await make({ cityId: city.id })
    await send('delete', superAdmin, `/${a.id}`)
    expect((await request(app).delete(`${API}/cities/${city.id}`).set(authed(superAdmin.token))).status).toBe(204)
    const res = await send('post', superAdmin, `/${a.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_STATE')
    expect(res.body.error.message).toContain('Restore CTest Metro')
  })
})
