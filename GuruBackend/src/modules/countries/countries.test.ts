import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const EMAIL_PREFIX = 'ctry-test'
const RUN = randomUUID().slice(0, 6)

let superAdmin: TestAdmin
let ops: TestAdmin // locations.read + locations.manage, not a super admin
let reader: TestAdmin // verification_admin: locations.read only
let outsider: TestAdmin // finance_admin: no location permissions at all

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

// iso2 is unique among live rows, so every fixture takes the next free code from a pool no real country uses.
let seq = 0
function nextCodes() {
  const prefix = ['Q', 'X', 'Z'][Math.floor(seq / 26) % 3]!
  const code = prefix + String.fromCharCode(65 + (seq % 26))
  seq += 1
  return { iso2: code, iso3: `${code}${prefix}` }
}
const countryName = (label: string) => `CTest ${label} ${RUN}`
// Search tests need names no other fixture resembles: the list search is fuzzy (trigram) by design.
const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`

type Body = Record<string, unknown>
async function make(overrides: Body = {}, as: { token: string } = superAdmin) {
  const { iso2, iso3 } = nextCodes()
  const res = await send('post', as, '/countries', { name: countryName(`C${seq}`), iso2, iso3, phoneCode: '+999', currencyCode: 'XTS', isActive: true, sortOrder: 5, ...overrides })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as { id: string; name: string; iso2: string; updatedAt: string; isActive: boolean; sortOrder: number; stateCount: number; deletedAt: string | null }
}
const patch = (id: string, body: Body, version: string, as: { token: string } = superAdmin) => send('patch', as, `/countries/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'countries').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)

async function addState(countryId: string) {
  await db.insertInto('states').values({ id: randomUUID(), country_id: countryId, name: `CTest State ${RUN}-${Math.random()}`, code: `T${Math.floor(Math.random() * 90 + 10)}` }).execute()
}

beforeAll(async () => {
  await purgeFixtures()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  reader = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
})

// Everything the test admins created, from this and any aborted earlier run: iso2 is unique, so stale rows would
// break the next run, and the admin rows cannot be deleted while countries still point at them.
async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const ids = (await db.selectFrom('countries').select('id').where('created_by', 'in', admins).execute()).map((c) => c.id)
  if (ids.length === 0) return
  await db.deleteFrom('states').where('country_id', 'in', ids).execute()
  await db.deleteFrom('countries').where('id', 'in', ids).execute()
}

afterAll(async () => {
  await purgeFixtures()
  await purgeRbacFixtures(EMAIL_PREFIX)
  await pool.end()
})

describe('permissions (section 13 / 20)', () => {
  it('rejects anonymous callers', async () => {
    expect((await request(app).get(`${API}/countries`)).status).toBe(401)
  })

  it('lets a read-only admin list but tells them they cannot change anything', async () => {
    const c = await make()
    expect((await get(reader, '/countries?q=CTest')).status).toBe(200)
    expect((await get(reader, `/countries/${c.id}`)).status).toBe(200)

    for (const res of [
      await send('post', reader, '/countries', { name: countryName('nope'), iso2: 'QQ', iso3: 'QQQ', phoneCode: '+1', currencyCode: 'USD' }),
      await patch(c.id, { sortOrder: 9 }, c.updatedAt, reader),
      await send('post', reader, `/countries/${c.id}/deactivate`, {}),
      await send('delete', reader, `/countries/${c.id}`),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can view countries but not change them.', details: { required: ['locations.manage'] } })
    }
  })

  it('blocks admins with no location permission from reading', async () => {
    const res = await get(outsider, '/countries')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['locations.read'] } })
  })

  it('lets an operations admin manage countries', async () => {
    const c = await make({}, ops)
    expect((await patch(c.id, { sortOrder: 6 }, c.updatedAt, ops)).status).toBe(200)
  })
})

describe('create (FR-7.2)', () => {
  it('creates a country, normalises input, defaults flags and audits it', async () => {
    const { iso2, iso3 } = nextCodes()
    const res = await send('post', superAdmin, '/countries', {
      name: `  ${countryName('United   Arab')}  `,
      iso2: iso2.toLowerCase(),
      iso3: iso3.toLowerCase(),
      phoneCode: '+971',
      currencyCode: 'aed',
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: countryName('United Arab'),
      iso2,
      iso3,
      phoneCode: '+971',
      currencyCode: 'AED',
      isActive: true,
      sortOrder: 0,
      stateCount: 0,
      deletedAt: null,
    })
    const stored = await db.selectFrom('countries').select(['created_by', 'updated_by']).where('id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(stored).toEqual({ created_by: superAdmin.id, updated_by: superAdmin.id })

    const log = await db.selectFrom('audit_logs').select(['action', 'actor_id', 'module', 'new_values']).where('entity_type', '=', 'countries').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(log).toMatchObject({ action: 'country.created', actor_id: superAdmin.id, module: 'locations' })
    expect(log.new_values).toMatchObject({ name: countryName('United Arab'), iso2 })
  })

  it('can be created inactive', async () => {
    expect((await make({ isActive: false })).isActive).toBe(false)
  })

  it.each([
    ['name too short', { name: 'A' }, 'name'],
    ['name too long', { name: 'x'.repeat(61) }, 'name'],
    ['iso2 not two letters', { iso2: 'IND' }, 'iso2'],
    ['iso2 with a digit', { iso2: 'Q1' }, 'iso2'],
    ['iso3 not three letters', { iso3: 'AB' }, 'iso3'],
    ['phone code without plus', { phoneCode: '91' }, 'phoneCode'],
    ['phone code too long', { phoneCode: '+12345' }, 'phoneCode'],
    ['currency not three letters', { currencyCode: 'RUPEE' }, 'currencyCode'],
    ['isActive not a boolean', { isActive: 'yes' }, 'isActive'],
    ['sortOrder above range', { sortOrder: 10000 }, 'sortOrder'],
    ['sortOrder negative', { sortOrder: -1 }, 'sortOrder'],
    ['sortOrder fractional', { sortOrder: 1.5 }, 'sortOrder'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_label, bad, field) => {
    const { iso2, iso3 } = nextCodes()
    const res = await send('post', superAdmin, '/countries', { name: countryName('bad'), iso2, iso3, phoneCode: '+1', currencyCode: 'USD', ...bad })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field)
  })

  it('rejects a missing field and an unknown field', async () => {
    expect((await send('post', superAdmin, '/countries', { name: countryName('half') })).status).toBe(422)
    const { iso2, iso3 } = nextCodes()
    expect((await send('post', superAdmin, '/countries', { name: countryName('extra'), iso2, iso3, phoneCode: '+1', currencyCode: 'USD', slug: 'x' })).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate name, ignoring case', async () => {
    const c = await make()
    const { iso2, iso3 } = nextCodes()
    const res = await send('post', superAdmin, '/countries', { name: c.name.toUpperCase(), iso2, iso3, phoneCode: '+1', currencyCode: 'USD' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'A country with this name already exists.', details: { field: 'name' } })
  })

  it('returns 409 CONFLICT_DUPLICATE for a duplicate iso2 and writes nothing', async () => {
    const c = await make()
    const res = await send('post', superAdmin, '/countries', { name: countryName('same-iso'), iso2: c.iso2, iso3: 'ZZZ', phoneCode: '+1', currencyCode: 'USD' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'iso2' } })
    expect(await db.selectFrom('countries').select('id').where('name', '=', countryName('same-iso')).executeTakeFirst()).toBeUndefined()
  })
})

describe('read (FR-7.1)', () => {
  it('returns one country with its live state count', async () => {
    const c = await make()
    await addState(c.id)
    await addState(c.id)
    const res = await get(reader, `/countries/${c.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, name: c.name, stateCount: 2 })
  })

  it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await get(superAdmin, `/countries/${id}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Country not found.' })
    }
  })

  it('lists with pagination meta, a prefix search and the default sortOrder ordering', async () => {
    const tag = uniqueTag()
    const a = await make({ name: `${tag} Charlie`, sortOrder: 30 })
    const b = await make({ name: `${tag} Alpha`, sortOrder: 10 })
    const c = await make({ name: `${tag} Bravo`, sortOrder: 20 })

    const res = await get(reader, `/countries?q=${encodeURIComponent(tag)}`)
    expect(res.status).toBe(200)
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 3, totalPages: 1 })
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([b.id, c.id, a.id])
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['createdAt', 'currencyCode', 'deletedAt', 'id', 'iso2', 'iso3', 'isActive', 'name', 'phoneCode', 'sortOrder', 'stateCount', 'updatedAt'].sort())

    const page2 = await get(reader, `/countries?q=${encodeURIComponent(tag)}&pageSize=2&page=2`)
    expect(page2.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 })
    expect(page2.body.data.map((r: { id: string }) => r.id)).toEqual([a.id])
  })

  it('sorts by name in either direction', async () => {
    const tag = uniqueTag()
    await make({ name: `${tag} A` })
    await make({ name: `${tag} B` })
    const q = encodeURIComponent(tag)
    const asc = (await get(reader, `/countries?q=${q}&sort=name:asc`)).body.data.map((r: { name: string }) => r.name)
    const desc = (await get(reader, `/countries?q=${q}&sort=name:desc`)).body.data.map((r: { name: string }) => r.name)
    expect(asc).toEqual([`${tag} A`, `${tag} B`])
    expect(desc).toEqual([...asc].reverse())
  })

  it('searches by exact iso2 and iso3', async () => {
    const c = await make()
    const { iso3 } = (await db.selectFrom('countries').select('iso3').where('id', '=', c.id).executeTakeFirstOrThrow()) as { iso3: string }
    for (const term of [c.iso2, c.iso2.toLowerCase(), iso3]) {
      const res = await get(reader, `/countries?q=${term}`)
      expect(res.status).toBe(200)
      expect(res.body.data.map((r: { id: string }) => r.id)).toContain(c.id)
    }
  })

  it('treats % and _ in the search term literally', async () => {
    const res = await get(reader, '/countries?q=%25')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('filters by active state', async () => {
    const tag = uniqueTag()
    const on = await make({ name: `${tag} On`, isActive: true })
    const off = await make({ name: `${tag} Off`, isActive: false })
    const q = encodeURIComponent(tag)
    const ids = async (extra: string) => (await get(reader, `/countries?q=${q}${extra}`)).body.data.map((r: { id: string }) => r.id)
    expect((await ids('')).sort()).toEqual([on.id, off.id].sort())
    expect(await ids('&active=true')).toEqual([on.id])
    expect(await ids('&active=false')).toEqual([off.id])
  })

  it.each([['pageSize=101'], ['pageSize=0'], ['page=0'], ['sort=iso2:asc'], ['active=maybe'], ['fields=name,secret']])('rejects ?%s with 422', async (qs) => {
    const res = await get(reader, `/countries?${qs}`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('hides deleted rows, and only a super admin may ask for them', async () => {
    const c = await make()
    expect((await send('delete', superAdmin, `/countries/${c.id}`)).status).toBe(204)

    const q = encodeURIComponent(c.name)
    const listed = (await get(reader, `/countries?q=${q}`)).body.data as { id: string }[]
    expect(listed.map((r) => r.id)).not.toContain(c.id) // fuzzy search may still return similarly named live rows
    expect((await get(reader, `/countries/${c.id}`)).status).toBe(404)

    expect((await get(ops, `/countries?q=${q}&includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/countries/${c.id}?includeDeleted=true`)).status).toBe(403)

    const withDeleted = await get(superAdmin, `/countries?q=${q}&includeDeleted=true`)
    const shown = withDeleted.body.data.find((r: { id: string }) => r.id === c.id)
    expect(shown.deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/countries/${c.id}?includeDeleted=true`)).status).toBe(200)
  })
})

describe('dropdown mode (FR-7.S2)', () => {
  it('returns only the requested fields, unpaginated, active rows only', async () => {
    const live = await make({ isActive: true })
    const inactive = await make({ isActive: false })
    const res = await get(reader, '/countries?active=true&fields=id,name')
    expect(res.status).toBe(200)
    expect(res.body.meta).toBeUndefined()
    const row = res.body.data.find((r: { id: string }) => r.id === live.id)
    expect(row).toEqual({ id: live.id, name: live.name })
    expect(res.body.data.some((r: { id: string }) => r.id === inactive.id)).toBe(false)
  })

  it('supports the contact fields the app forms need', async () => {
    const c = await make({ phoneCode: '+977' })
    const res = await get(reader, '/countries?active=true&fields=id,name,iso2,phoneCode')
    expect(res.body.data.find((r: { id: string }) => r.id === c.id)).toEqual({ id: c.id, name: c.name, iso2: c.iso2, phoneCode: '+977' })
  })

  it('purges the cached list on every write in the module', async () => {
    const url = '/countries?active=true&fields=id,name'
    const before = await get(reader, url) // warms the cache
    const created = await make()
    const afterCreate = await get(reader, url)
    expect(afterCreate.body.data.some((r: { id: string }) => r.id === created.id)).toBe(true)
    expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

    await send('post', superAdmin, `/countries/${created.id}/deactivate`, {})
    expect((await get(reader, url)).body.data.some((r: { id: string }) => r.id === created.id)).toBe(false)

    await send('post', superAdmin, `/countries/${created.id}/activate`, {})
    expect((await get(reader, url)).body.data.some((r: { id: string }) => r.id === created.id)).toBe(true)

    const edited = (await get(reader, `/countries/${created.id}`)).body.data
    const renamed = `${created.name} Renamed`
    await patch(created.id, { name: renamed }, edited.updatedAt)
    expect((await get(reader, url)).body.data.find((r: { id: string }) => r.id === created.id).name).toBe(renamed)

    await send('delete', superAdmin, `/countries/${created.id}`)
    expect((await get(reader, url)).body.data.some((r: { id: string }) => r.id === created.id)).toBe(false)
  })
})

describe('update (FR-7.3)', () => {
  it('changes only the sent fields, returns the new version and audits the diff', async () => {
    const c = await make({ sortOrder: 5 })
    const res = await patch(c.id, { sortOrder: 7, currencyCode: 'inr' }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, name: c.name, sortOrder: 7, currencyCode: 'INR' })
    expect(res.body.data.updatedAt).not.toBe(c.updatedAt)

    const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values']).where('entity_id', '=', c.id).where('action', '=', 'country.updated').executeTakeFirstOrThrow()
    expect(log.old_values).toEqual({ sortOrder: 5, currencyCode: 'XTS' })
    expect(log.new_values).toEqual({ sortOrder: 7, currencyCode: 'INR' })
    const stored = await db.selectFrom('countries').select('updated_by').where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored.updated_by).toBe(superAdmin.id)
  })

  it('treats an unchanged value as a no-op: same version, no audit row', async () => {
    const c = await make()
    const res = await patch(c.id, { sortOrder: c.sortOrder }, c.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['country.created'])
  })

  it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
    const c = await make()
    expect((await patch(c.id, { sortOrder: 6 }, c.updatedAt)).status).toBe(200)
    const stale = await patch(c.id, { sortOrder: 8 }, c.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Someone else changed this country. Reload.', details: { current: { id: c.id, sortOrder: 6 } } })
  })

  it('requires an If-Match header', async () => {
    const c = await make()
    const res = await send('patch', superAdmin, `/countries/${c.id}`, { sortOrder: 6 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an empty body, an invalid value and an unknown field', async () => {
    const c = await make()
    expect((await patch(c.id, {}, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { iso2: 'ABC' }, c.updatedAt)).status).toBe(422)
    expect((await patch(c.id, { id: randomUUID() }, c.updatedAt)).status).toBe(422)
  })

  it('returns 409 CONFLICT_DUPLICATE when renaming onto another country', async () => {
    const a = await make()
    const b = await make()
    const res = await patch(b.id, { name: a.name.toLowerCase() }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'name' } })
    const clash = await patch(b.id, { iso2: a.iso2 }, b.updatedAt)
    expect(clash.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: 'iso2' } })
  })

  it('returns 404 for an unknown or deleted country', async () => {
    const c = await make()
    await send('delete', superAdmin, `/countries/${c.id}`)
    expect((await patch(c.id, { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch(randomUUID(), { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
    expect((await patch('nope', { sortOrder: 1 }, c.updatedAt)).status).toBe(404)
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const c = await make()
    const [x, y] = await Promise.all([patch(c.id, { sortOrder: 11 }, c.updatedAt), patch(c.id, { sortOrder: 12 }, c.updatedAt)])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })
})

describe('activate / deactivate (FR-7.4)', () => {
  it('toggles the flag, records the reason and keeps the row', async () => {
    const c = await make({ isActive: true })
    const off = await send('post', superAdmin, `/countries/${c.id}/deactivate`, { reason: 'Pausing launch' })
    expect(off.status).toBe(200)
    expect(off.body.data.isActive).toBe(false)
    const on = await send('post', superAdmin, `/countries/${c.id}/activate`)
    expect(on.status).toBe(200)
    expect(on.body.data.isActive).toBe(true)

    expect(await auditActions(c.id)).toEqual(['country.created', 'country.deactivated', 'country.activated'])
    const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', c.id).where('action', '=', 'country.deactivated').executeTakeFirstOrThrow()
    expect(log.reason).toBe('Pausing launch')
  })

  it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
    const c = await make({ isActive: true })
    const again = await send('post', superAdmin, `/countries/${c.id}/activate`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(c.updatedAt)
    expect(await auditActions(c.id)).toEqual(['country.created'])
  })

  it('keeps the states of a deactivated country untouched', async () => {
    const c = await make()
    await addState(c.id)
    await send('post', superAdmin, `/countries/${c.id}/deactivate`, {})
    expect((await get(superAdmin, `/countries/${c.id}`)).body.data.stateCount).toBe(1)
  })

  it('returns 404 for an unknown country and 422 for an over-long reason', async () => {
    expect((await send('post', superAdmin, `/countries/${randomUUID()}/activate`, {})).status).toBe(404)
    const c = await make()
    expect((await send('post', superAdmin, `/countries/${c.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
  })
})

describe('delete (FR-7.5)', () => {
  it('soft-deletes an unused country and frees its name and code', async () => {
    const c = await make()
    const res = await send('delete', superAdmin, `/countries/${c.id}`)
    expect(res.status).toBe(204)
    const stored = await db.selectFrom('countries').select(['deleted_at', 'deleted_by']).where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
    expect(stored.deleted_by).toBe(superAdmin.id)
    expect(await auditActions(c.id)).toEqual(['country.created', 'country.deleted'])

    const reuse = await send('post', superAdmin, '/countries', { name: c.name, iso2: c.iso2, iso3: 'ZZZ', phoneCode: '+1', currencyCode: 'USD' })
    expect(reuse.status).toBe(201)
    expect((await send('delete', superAdmin, `/countries/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_IN_USE with reference counts while states use it', async () => {
    const c = await make()
    await addState(c.id)
    await addState(c.id)
    const res = await send('delete', superAdmin, `/countries/${c.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_IN_USE', message: 'This country is in use. Deactivate it instead.', details: { references: { states: 2 } } })
    expect((await get(superAdmin, `/countries/${c.id}`)).status).toBe(200)
    expect(await auditActions(c.id)).toEqual(['country.created'])
  })

  it('ignores soft-deleted states when checking usage', async () => {
    const c = await make()
    await db.insertInto('states').values({ id: randomUUID(), country_id: c.id, name: `CTest Gone ${RUN}`, code: 'T00', deleted_at: new Date() }).execute()
    expect((await send('delete', superAdmin, `/countries/${c.id}`)).status).toBe(204)
  })

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await send('delete', superAdmin, `/countries/${randomUUID()}`)).status).toBe(404)
    expect((await send('delete', superAdmin, '/countries/nope')).status).toBe(404)
  })
})

describe('restore (FR-7.6)', () => {
  it('lets a super admin undelete a country', async () => {
    const c = await make()
    await send('delete', superAdmin, `/countries/${c.id}`)
    const res = await send('post', superAdmin, `/countries/${c.id}/restore`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: c.id, deletedAt: null, name: c.name })
    expect(await auditActions(c.id)).toEqual(['country.created', 'country.deleted', 'country.restored'])
    expect((await get(reader, `/countries/${c.id}`)).status).toBe(200)
  })

  it('is refused for an admin who is not a super admin, even with locations.manage', async () => {
    const c = await make()
    await send('delete', superAdmin, `/countries/${c.id}`)
    const res = await send('post', ops, `/countries/${c.id}/restore`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await get(superAdmin, `/countries/${c.id}`)).status).toBe(404)
  })

  it('returns 409 CONFLICT_DUPLICATE when the unique fields were taken meanwhile', async () => {
    const c = await make()
    await send('delete', superAdmin, `/countries/${c.id}`)
    await send('post', superAdmin, '/countries', { name: c.name, iso2: c.iso2, iso3: 'ZZZ', phoneCode: '+1', currencyCode: 'USD' })
    const res = await send('post', superAdmin, `/countries/${c.id}/restore`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
    const stored = await db.selectFrom('countries').select('deleted_at').where('id', '=', c.id).executeTakeFirstOrThrow()
    expect(stored.deleted_at).not.toBeNull()
  })

  it('returns 409 CONFLICT_STATE for a country that is not deleted, 404 for an unknown one', async () => {
    const c = await make()
    const live = await send('post', superAdmin, `/countries/${c.id}/restore`)
    expect(live.status).toBe(409)
    expect(live.body.error.code).toBe('CONFLICT_STATE')
    expect((await send('post', superAdmin, `/countries/${randomUUID()}/restore`)).status).toBe(404)
  })
})
