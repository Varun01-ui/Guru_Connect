import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db } from '../../db/index.js'
import { API, adminUpload, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { jpegOf, pngOf } from '../../test/images.js'
import { runBannerLifecycle } from './banners.service.js'

const app = createApp()
const EMAIL_PREFIX = 'ban-test'
const RUN = randomUUID().slice(0, 6)
const APP_API = '/api/v1/app'

let superAdmin: TestAdmin
let ops: TestAdmin // banners.read + banners.manage
let reader: TestAdmin // banners.read only
let outsider: TestAdmin // finance: no banner permissions
let cityA: { id: string; name: string }
let cityB: { id: string; name: string }
let allowedDomains: unknown

type Body = Record<string, unknown>
const DAY = 86_400_000
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
const tag = (label: string) => `BT ${label} ${RUN}`

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'patch' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

let imageCache: string[] = []
async function newImage(as: TestAdmin = ops, bytes = pngOf(1080, 480)): Promise<string> {
  const up = await adminUpload(app, as, { purpose: 'banner_image', bytes, mimeType: bytes[0] === 0xff ? 'image/jpeg' : 'image/png' })
  expect(up.confirmed!.status, JSON.stringify(up.confirmed?.body)).toBe(200)
  imageCache.push(up.fileId!)
  return up.fileId!
}

type Banner = { id: string; status: string; title: string; updatedAt: string; priority: number; placement: string; impressions: number; clicks: number; ctrPct: number | null; cities: { id: string; name: string }[]; image: { fileId: string; url: string } }
async function make(overrides: Body = {}, as: TestAdmin = ops) {
  const res = await send('post', as, '/banners', {
    title: tag('Banner'),
    imageFileId: await newImage(),
    placement: 'home_top',
    audience: 'parents',
    startsAt: iso(-DAY),
    endsAt: iso(30 * DAY),
    ...overrides,
  })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as Banner
}
const makeLive = async (overrides: Body = {}) => {
  const b = await make(overrides)
  const res = await send('post', ops, `/banners/${b.id}/publish`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as Banner
}
const patch = (id: string, body: Body, version: string, as: TestAdmin = ops) => send('patch', as, `/banners/${id}`, body, { 'If-Match': version })
const auditActions = async (id: string) =>
  (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', 'banners').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
const serve = (placement: string, extra = '') => request(app).get(`${APP_API}/banners?placement=${placement}${extra}`)

async function purgeFixtures() {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${EMAIL_PREFIX}-%`).execute()).map((a) => a.id)
  if (admins.length === 0) return
  const banners = (await db.selectFrom('banners').select('id').where('created_by', 'in', admins).execute()).map((b) => b.id)
  if (banners.length) {
    await db.deleteFrom('audit_logs').where('entity_type', '=', 'banners').where('entity_id', 'in', banners).execute()
    await db.deleteFrom('banners').where('id', 'in', banners).execute()
  }
}

beforeAll(async () => {
  await purgeFixtures()
  const cities = await db.selectFrom('cities').select(['id', 'name']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('name').limit(2).execute()
  cityA = cities[0]!
  cityB = cities[1]!
  allowedDomains = (await db.selectFrom('system_settings').select('value').where('key', '=', 'banners.allowed_domains').executeTakeFirstOrThrow()).value

  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })

  const role = await db.insertInto('roles').values({ code: `rbac_test_banner_reader_${RUN}`, name: `RBAC Test Banner Reader ${RUN}` }).returning('id').executeTakeFirstOrThrow()
  await db.insertInto('role_permissions').columns(['role_id', 'permission_id']).expression((eb) => eb.selectFrom('permissions').select([eb.val(role.id).as('role_id'), 'id']).where('key', '=', 'banners.read')).execute()
  reader = await createAdminWithToken({ roles: [`rbac_test_banner_reader_${RUN}`], emailPrefix: EMAIL_PREFIX })
})

afterAll(async () => {
  await purgeFixtures()
  await db.updateTable('system_settings').set({ value: JSON.stringify(allowedDomains) as never }).where('key', '=', 'banners.allowed_domains').execute()
  await db.deleteFrom('files').where('id', 'in', imageCache.length ? imageCache : [randomUUID()]).execute()
  await purgeRbacFixtures(EMAIL_PREFIX)
})

describe('permissions', () => {
  it('needs a signed-in admin', async () => {
    expect((await request(app).get(`${API}/banners`)).status).toBe(401)
    expect((await request(app).post(`${API}/banners`).send({})).status).toBe(401)
  })

  it('lets a reader look but not change anything', async () => {
    const b = await make()
    expect((await get(reader, '/banners')).status).toBe(200)
    expect((await get(reader, `/banners/${b.id}`)).status).toBe(200)
    expect((await get(reader, '/banners/preview')).status).toBe(200)
    for (const [method, path, body] of [
      ['post', '/banners', {}],
      ['patch', `/banners/${b.id}`, { title: 'Nope nope' }],
      ['post', `/banners/${b.id}/publish`, undefined],
      ['post', `/banners/${b.id}/pause`, undefined],
      ['post', `/banners/${b.id}/resume`, undefined],
      ['post', '/banners/reorder', {}],
      ['delete', `/banners/${b.id}`, undefined],
    ] as const) {
      const res = await send(method, reader, path, body, { 'If-Match': b.updatedAt })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.body.error.details.required).toEqual(['banners.manage'])
    }
    expect((await get(superAdmin, `/banners/${b.id}`)).body.data.status).toBe('draft')
  })

  it('refuses an admin with no banner permission at all', async () => {
    expect((await get(outsider, '/banners')).status).toBe(403)
    expect((await send('post', outsider, '/banners', {})).status).toBe(403)
  })
})

describe('create', () => {
  it('creates a draft with the image, cities and audit row', async () => {
    const b = await make({ cityIds: [cityA.id, cityB.id, cityA.id], subtitle: 'Book a free demo', deepLink: 'gc://plans', priority: 40 })
    expect(b).toMatchObject({ status: 'draft', impressions: 0, clicks: 0, ctrPct: null, priority: 40, placement: 'home_top' })
    expect(b.cities.map((c) => c.id).sort()).toEqual([cityA.id, cityB.id].sort())
    expect(b.image.url).toMatch(/\/banners\/.+\.png$/)
    expect(await auditActions(b.id)).toEqual(['banner.created'])
    const row = await db.selectFrom('banners').select(['created_by', 'updated_by']).where('id', '=', b.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ created_by: ops.id, updated_by: ops.id })
  })

  it('applies defaults: audience all, no cities, priority 0, no end', async () => {
    const res = await send('post', ops, '/banners', { title: tag('Defaults'), imageFileId: await newImage(), placement: 'onboarding', startsAt: iso(DAY) })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ audience: 'all', cities: [], priority: 0, endsAt: null, deepLink: null, subtitle: null })
  })

  it('accepts JPEG banners and ±2 px tolerance', async () => {
    expect((await make({ imageFileId: await newImage(ops, jpegOf(1080, 480)) })).id).toBeTruthy()
    expect((await make({ imageFileId: await newImage(ops, pngOf(1082, 478)) })).id).toBeTruthy()
  })

  it.each([
    ['title too short', { title: 'ab' }, 'title', 'Title must be 3–60 characters.'],
    ['title too long', { title: 'x'.repeat(61) }, 'title', 'Title must be 3–60 characters.'],
    ['subtitle too long', { subtitle: 'x'.repeat(91) }, 'subtitle', 'Subtitle can be up to 90 characters.'],
    ['placement unknown', { placement: 'footer' }, 'placement', 'Choose where the banner shows.'],
    ['audience unknown', { audience: 'everyone' }, 'audience', 'Choose who sees the banner.'],
    ['priority above 100', { priority: 101 }, 'priority', 'Priority must be 0–100.'],
    ['priority negative', { priority: -1 }, 'priority', 'Priority must be 0–100.'],
    ['priority fractional', { priority: 1.5 }, 'priority', 'Priority must be 0–100.'],
    ['start missing', { startsAt: undefined }, 'startsAt', 'Pick a start date and time.'],
    ['start malformed', { startsAt: 'tomorrow' }, 'startsAt', 'Pick a start date and time.'],
    ['city not a uuid', { cityIds: ['bengaluru'] }, 'cityIds.0', 'Pick cities from the list.'],
    ['image missing', { imageFileId: undefined }, 'imageFileId', 'Upload the banner image.'],
  ])('rejects %s (422)', async (_label, over, path, message) => {
    const res = await send('post', ops, '/banners', { title: tag('Bad'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), ...over })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details[0]).toEqual({ path, message })
  })

  it('rejects an end before the start and a run longer than 180 days', async () => {
    const before = await send('post', ops, '/banners', { title: tag('Window'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), endsAt: iso(0) })
    expect(before.status).toBe(422)
    expect(before.body.error.details[0]).toEqual({ path: 'endsAt', message: 'The end must be after the start.' })
    const long = await send('post', ops, '/banners', { title: tag('Window'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), endsAt: iso(DAY + 181 * DAY) })
    expect(long.status).toBe(422)
    expect(long.body.error.details[0].message).toBe('A banner can run for at most 180 days.')
    const start = new Date(Date.now() + DAY)
    const exactly = await send('post', ops, '/banners', { title: tag('Window'), imageFileId: await newImage(), placement: 'home_top', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 180 * DAY).toISOString() })
    expect(exactly.status).toBe(201)
  })

  it('rejects a wrongly sized image (422)', async () => {
    for (const bytes of [pngOf(800, 400), pngOf(1080, 600), jpegOf(1000, 480)]) {
      const res = await send('post', ops, '/banners', { title: tag('Size'), imageFileId: await newImage(ops, bytes), placement: 'home_top', startsAt: iso(DAY) })
      expect(res.status).toBe(422)
      expect(res.body.error.details[0]).toEqual({ path: 'imageFileId', message: 'Banner images must be 1080 × 480 px.' })
    }
  })

  it('rejects a file that is not a finished banner image', async () => {
    const avatar = await adminUpload(app, ops, { purpose: 'admin_avatar', bytes: pngOf(1080, 480) })
    imageCache.push(avatar.fileId!)
    const pending = await send('post', ops, '/uploads/presign', { purpose: 'banner_image', mimeType: 'image/png', sizeBytes: 100, fileName: 'x.png' })
    for (const id of [avatar.fileId, pending.body.data.fileId, randomUUID()]) {
      const res = await send('post', ops, '/banners', { title: tag('File'), imageFileId: id, placement: 'home_top', startsAt: iso(DAY) })
      expect(res.status).toBe(422)
      expect(res.body.error.details[0]).toEqual({ path: 'imageFileId', message: 'Upload the banner image first.' })
    }
  })

  it('rejects cities that are unknown, inactive or deleted, and more than 50', async () => {
    const unknown = await send('post', ops, '/banners', { title: tag('City'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), cityIds: [randomUUID()] })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error.details[0]).toEqual({ path: 'cityIds', message: 'Pick active cities from the list.' })
    const many = await send('post', ops, '/banners', { title: tag('City'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), cityIds: Array.from({ length: 51 }, () => randomUUID()) })
    expect(many.status).toBe(422)
    expect(many.body.error.details[0].message).toBe('Pick up to 50 cities.')
  })

  it.each([
    'https://evil.example.com/phish',
    'http://guruconnect.in/offers',
    'gc://wallet',
    'gc://search?evil=1',
    'javascript:alert(1)',
    'guruconnect.in',
  ])('rejects the deep link %s (422)', async (deepLink) => {
    const res = await send('post', ops, '/banners', { title: tag('Link'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), deepLink })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0]).toEqual({ path: 'deepLink', message: 'Use an app link or an approved website.' })
  })

  it('accepts app routes and approved websites, following the allow-list setting', async () => {
    for (const deepLink of ['gc://search?classId=10', 'gc://referral', 'gc://blog/exam-tips', `gc://teacher/${randomUUID()}`, 'https://guruconnect.in/offers', 'https://blog.guruconnect.in/x']) {
      expect((await make({ deepLink })).id, deepLink).toBeTruthy()
    }
    const denied = await send('post', ops, '/banners', { title: tag('Link'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), deepLink: 'https://partner.example.org/deal' })
    expect(denied.status).toBe(422)
    await db.updateTable('system_settings').set({ value: JSON.stringify(['guruconnect.in', 'partner.example.org']) as never }).where('key', '=', 'banners.allowed_domains').execute()
    expect((await make({ deepLink: 'https://partner.example.org/deal' })).id).toBeTruthy()
  })

  it('rejects unknown fields and an empty body', async () => {
    expect((await send('post', ops, '/banners', { title: tag('X'), imageFileId: await newImage(), placement: 'home_top', startsAt: iso(DAY), status: 'active' })).status).toBe(422)
    expect((await send('post', ops, '/banners', {})).status).toBe(422)
  })
})

describe('read', () => {
  it('returns one banner, 404 for a missing or malformed id', async () => {
    const b = await make({ cityIds: [cityA.id] })
    const res = await get(ops, `/banners/${b.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: b.id, cities: [{ id: cityA.id, name: cityA.name }], createdBy: { id: ops.id } })
    expect((await get(ops, `/banners/${randomUUID()}`)).status).toBe(404)
    expect((await get(ops, '/banners/not-a-uuid')).status).toBe(404)
  })

  describe('list', () => {
    let a: Banner
    let b: Banner
    let c: Banner
    beforeAll(async () => {
      a = await make({ title: tag('List alpha'), placement: 'search_inline', audience: 'teachers', priority: 10 })
      b = await makeLive({ title: tag('List bravo'), placement: 'search_inline', audience: 'students', cityIds: [cityA.id], priority: 90 })
      c = await make({ title: tag('List charlie'), placement: 'search_inline', audience: 'teachers', priority: 50, startsAt: iso(5 * DAY), endsAt: iso(10 * DAY) })
      await send('post', ops, `/banners/${c.id}/publish`)
    })
    const ids = (res: request.Response) => (res.body.data as Banner[]).map((x) => x.id)

    it('filters by placement, status, audience and title (contains, case-insensitive)', async () => {
      const all = await get(ops, `/banners?placement=search_inline&q=${encodeURIComponent(`${RUN}`)}`)
      expect(ids(all)).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
      expect(ids(await get(ops, `/banners?placement=search_inline&status=draft&q=${RUN}`))).toEqual([a.id])
      expect(ids(await get(ops, `/banners?placement=search_inline&status=active&q=${RUN}`))).toEqual([b.id])
      expect(ids(await get(ops, `/banners?placement=search_inline&status=scheduled&q=${RUN}`))).toEqual([c.id])
      expect(ids(await get(ops, `/banners?placement=search_inline&audience=students&q=${RUN}`))).toEqual([b.id])
      expect(ids(await get(ops, `/banners?q=${encodeURIComponent('LIST BRAVO')}`))).toContain(b.id)
      expect(ids(await get(ops, `/banners?q=${encodeURIComponent('%')}`))).toEqual([]) // wildcard is literal
    })

    it('filters by city (city-targeted or all-cities) and by the day it is live', async () => {
      const inA = ids(await get(ops, `/banners?placement=search_inline&cityId=${cityA.id}&q=${RUN}`))
      expect(inA).toEqual(expect.arrayContaining([a.id, b.id]))
      const inB = ids(await get(ops, `/banners?placement=search_inline&cityId=${cityB.id}&q=${RUN}`))
      expect(inB).toContain(a.id)
      expect(inB).not.toContain(b.id)

      const today = new Date().toISOString().slice(0, 10)
      const live = ids(await get(ops, `/banners?placement=search_inline&activeOn=${today}&q=${RUN}`))
      expect(live).toContain(b.id)
      expect(live).not.toContain(a.id) // drafts are never "live"
      expect(live).not.toContain(c.id) // starts in 5 days
      const later = new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10)
      expect(ids(await get(ops, `/banners?placement=search_inline&activeOn=${later}&q=${RUN}`))).toContain(c.id)
    })

    it('sorts by priority (default, highest first) and by start date', async () => {
      const byPriority = ids(await get(ops, `/banners?placement=search_inline&q=${RUN}`)).filter((id) => [a.id, b.id, c.id].includes(id))
      expect(byPriority).toEqual([b.id, c.id, a.id])
      const lowFirst = ids(await get(ops, `/banners?placement=search_inline&sort=priority:asc&q=${RUN}`)).filter((id) => [a.id, b.id, c.id].includes(id))
      expect(lowFirst).toEqual([a.id, c.id, b.id])
      const byStart = ids(await get(ops, `/banners?placement=search_inline&sort=startsAt:desc&q=${RUN}`)).filter((id) => [a.id, b.id, c.id].includes(id))
      expect(byStart[0]).toBe(c.id)
    })

    it('sorts by click-through rate, banners without impressions last', async () => {
      await db.updateTable('banners').set({ impressions: 200, clicks: 50 }).where('id', '=', b.id).execute()
      await db.updateTable('banners').set({ impressions: 100, clicks: 5 }).where('id', '=', c.id).execute()
      const res = await get(ops, `/banners?placement=search_inline&sort=ctr:desc&q=${RUN}`)
      const order = ids(res).filter((id) => [a.id, b.id, c.id].includes(id))
      expect(order).toEqual([b.id, c.id, a.id])
      const first = (res.body.data as Banner[]).find((x) => x.id === b.id)!
      expect(first).toMatchObject({ impressions: 200, clicks: 50, ctrPct: 25 })
    })

    it('paginates with meta', async () => {
      const res = await get(ops, `/banners?placement=search_inline&q=${RUN}&pageSize=2&page=2`)
      expect(res.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 })
      expect(res.body.data).toHaveLength(1)
    })

    it('rejects bad query parameters (422)', async () => {
      for (const q of ['placement=nope', 'status=nope', 'audience=nope', 'cityId=x', 'activeOn=15-01-2027', 'sort=title:asc', 'pageSize=500', 'page=0']) {
        expect((await get(ops, `/banners?${q}`)).status, q).toBe(422)
      }
    })
  })

  it('shows deleted banners to a Super Admin only', async () => {
    const b = await make({ title: tag('Deleted one') })
    await send('delete', ops, `/banners/${b.id}`)
    expect((await get(ops, `/banners?includeDeleted=true`)).status).toBe(403)
    expect((await get(ops, `/banners/${b.id}?includeDeleted=true`)).status).toBe(403)
    const list = await get(superAdmin, `/banners?includeDeleted=true&q=${encodeURIComponent('Deleted one')}`)
    expect(list.body.data.map((x: Banner) => x.id)).toContain(b.id)
    expect((await get(superAdmin, `/banners/${b.id}?includeDeleted=true`)).body.data.deletedAt).not.toBeNull()
    expect((await get(superAdmin, `/banners/${b.id}`)).status).toBe(404)
    expect((await get(ops, `/banners?q=${encodeURIComponent('Deleted one')}`)).body.data).toHaveLength(0)
  })
})

describe('edit', () => {
  it('edits fields, audits only what changed, and bumps updatedAt', async () => {
    const b = await make({ cityIds: [cityA.id] })
    await new Promise((r) => setTimeout(r, 15))
    const res = await patch(b.id, { title: tag('Renamed'), subtitle: 'New line', priority: 70, cityIds: [cityB.id], deepLink: 'gc://plans' }, b.updatedAt)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ title: tag('Renamed'), subtitle: 'New line', priority: 70, deepLink: 'gc://plans', cities: [{ id: cityB.id }] })
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(new Date(b.updatedAt).getTime())
    const entry = await db.selectFrom('audit_logs').selectAll().where('entity_id', '=', b.id).where('action', '=', 'banner.updated').executeTakeFirstOrThrow()
    expect(Object.keys(entry.new_values as object).sort()).toEqual(['cityIds', 'deepLink', 'priority', 'subtitle', 'title'])
    expect(entry.old_values).toMatchObject({ priority: 0 })
  })

  it('clears optional fields with null', async () => {
    const b = await make({ subtitle: 'x line', deepLink: 'gc://plans' })
    const res = await patch(b.id, { subtitle: null, deepLink: null, endsAt: null, cityIds: [] }, b.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ subtitle: null, deepLink: null, endsAt: null, cities: [] })
  })

  it('swaps the image after checking the new one', async () => {
    const b = await make()
    const bad = await patch(b.id, { imageFileId: await newImage(ops, pngOf(10, 10)) }, b.updatedAt)
    expect(bad.status).toBe(422)
    const fresh = await newImage()
    const ok = await patch(b.id, { imageFileId: fresh }, b.updatedAt)
    expect(ok.status).toBe(200)
    expect(ok.body.data.image.fileId).toBe(fresh)
  })

  it('is a no-op when nothing really changes, even if an instant is written with another offset', async () => {
    const b = await make({ startsAt: '2030-01-01T00:00:00.000Z', endsAt: '2030-02-01T00:00:00.000Z' })
    const res = await patch(b.id, { title: b.title, startsAt: '2030-01-01T05:30:00+05:30' }, b.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.updatedAt).toBe(b.updatedAt)
    expect(await auditActions(b.id)).toEqual(['banner.created'])
  })

  it('refuses a stale form (409) with the current banner attached', async () => {
    const b = await make()
    await new Promise((r) => setTimeout(r, 15))
    expect((await patch(b.id, { title: tag('First') }, b.updatedAt)).status).toBe(200)
    const res = await patch(b.id, { title: tag('Second') }, b.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
    expect(res.body.error.details.current.title).toBe(tag('First'))
  })

  it('needs If-Match and a valid body', async () => {
    const b = await make()
    expect((await send('patch', ops, `/banners/${b.id}`, { title: tag('X') })).status).toBe(422)
    expect((await patch(b.id, {}, b.updatedAt)).status).toBe(422)
    expect((await patch(b.id, { status: 'active' }, b.updatedAt)).status).toBe(422)
    expect((await patch(b.id, { title: 'ab' }, b.updatedAt)).status).toBe(422)
    expect((await patch(randomUUID(), { title: tag('X') }, b.updatedAt)).status).toBe(404)
  })

  it('validates the window against the stored dates', async () => {
    const b = await make({ startsAt: iso(DAY), endsAt: iso(5 * DAY) })
    const res = await patch(b.id, { endsAt: iso(0) }, b.updatedAt)
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('endsAt')
  })

  it('does not let a live banner be given an end date in the past (409)', async () => {
    const live = await makeLive()
    const res = await patch(live.id, { endsAt: iso(-60_000), startsAt: iso(-2 * DAY) }, live.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "This banner's end date has passed." })
  })

  it('does not edit a banner that has expired (409)', async () => {
    const live = await makeLive()
    // Force the end into the past, then let the job expire it.
    await db.updateTable('banners').set({ ends_at: new Date(Date.now() - 1000), starts_at: new Date(Date.now() - 2 * DAY) }).where('id', '=', live.id).execute()
    await runBannerLifecycle()
    const fresh = (await get(ops, `/banners/${live.id}`)).body.data as Banner
    expect(fresh.status).toBe('expired')
    const res = await patch(live.id, { title: tag('Too late') }, fresh.updatedAt)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_STATE')
  })
})

describe('lifecycle', () => {
  it('publishes a draft that has started straight to active, and a future one to scheduled', async () => {
    const now = await make()
    const live = await send('post', ops, `/banners/${now.id}/publish`)
    expect(live.body.data.status).toBe('active')
    const later = await make({ startsAt: iso(2 * DAY), endsAt: iso(9 * DAY) })
    const scheduled = await send('post', ops, `/banners/${later.id}/publish`)
    expect(scheduled.body.data.status).toBe('scheduled')
    expect(await auditActions(later.id)).toEqual(['banner.created', 'banner.published'])
  })

  it('refuses to publish a banner whose end has passed (409), or one that is not a draft', async () => {
    const ended = await make({ startsAt: iso(-3 * DAY), endsAt: iso(-DAY) })
    const res = await send('post', ops, `/banners/${ended.id}/publish`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "This banner's end date has passed." })
    const live = await makeLive()
    const again = await send('post', ops, `/banners/${live.id}/publish`)
    expect(again.status).toBe(409)
    expect(again.body.error.details.currentStatus).toBe('active')
  })

  it('pauses and resumes', async () => {
    const live = await makeLive()
    const paused = await send('post', ops, `/banners/${live.id}/pause`)
    expect(paused.body.data.status).toBe('paused')
    expect((await send('post', ops, `/banners/${live.id}/pause`)).status).toBe(409)
    const resumed = await send('post', ops, `/banners/${live.id}/resume`)
    expect(resumed.body.data.status).toBe('active')
    expect((await send('post', ops, `/banners/${live.id}/resume`)).status).toBe(409)
    expect(await auditActions(live.id)).toEqual(['banner.created', 'banner.published', 'banner.paused', 'banner.resumed'])
  })

  it('only pauses active banners and only resumes paused ones', async () => {
    const draft = await make()
    expect((await send('post', ops, `/banners/${draft.id}/pause`)).status).toBe(409)
    expect((await send('post', ops, `/banners/${draft.id}/resume`)).status).toBe(409)
    const scheduled = await make({ startsAt: iso(DAY), endsAt: iso(5 * DAY) })
    await send('post', ops, `/banners/${scheduled.id}/publish`)
    expect((await send('post', ops, `/banners/${scheduled.id}/pause`)).status).toBe(409)
  })

  it('resumes a paused banner as scheduled if it has not started, and refuses if it has ended (409)', async () => {
    const live = await makeLive()
    await send('post', ops, `/banners/${live.id}/pause`)
    await db.updateTable('banners').set({ starts_at: new Date(Date.now() + DAY), ends_at: new Date(Date.now() + 3 * DAY) }).where('id', '=', live.id).execute()
    expect((await send('post', ops, `/banners/${live.id}/resume`)).body.data.status).toBe('scheduled')

    const other = await makeLive()
    await send('post', ops, `/banners/${other.id}/pause`)
    await db.updateTable('banners').set({ starts_at: new Date(Date.now() - 3 * DAY), ends_at: new Date(Date.now() - DAY) }).where('id', '=', other.id).execute()
    const res = await send('post', ops, `/banners/${other.id}/resume`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toBe("This banner's end date has passed.")
  })

  it('the job activates scheduled banners at their start and expires finished ones', async () => {
    const soon = await make({ startsAt: iso(2 * DAY), endsAt: iso(9 * DAY) })
    await send('post', ops, `/banners/${soon.id}/publish`)
    const ending = await makeLive()
    const paused = await makeLive()
    await send('post', ops, `/banners/${paused.id}/pause`)

    await db.updateTable('banners').set({ starts_at: new Date(Date.now() - 60_000) }).where('id', '=', soon.id).execute()
    await db.updateTable('banners').set({ starts_at: new Date(Date.now() - 2 * DAY), ends_at: new Date(Date.now() - 60_000) }).where('id', 'in', [ending.id, paused.id]).execute()

    const first = await runBannerLifecycle()
    expect(first.activated).toBeGreaterThanOrEqual(1)
    expect(first.expired).toBeGreaterThanOrEqual(1)
    const status = async (id: string) => ((await get(ops, `/banners/${id}`)).body.data as Banner).status
    expect(await status(soon.id)).toBe('active')
    expect(await status(ending.id)).toBe('expired')
    expect(await status(paused.id)).toBe('paused') // a paused banner stays paused: it was stopped on purpose
    const second = await runBannerLifecycle()
    expect(second).toEqual({ activated: 0, expired: 0 })
    const system = await db.selectFrom('audit_logs').select(['action', 'actor_type']).where('entity_id', '=', ending.id).where('action', '=', 'banner.expired').executeTakeFirstOrThrow()
    expect(system.actor_type).toBe('system')
  })

  it('a scheduled banner that already ended expires without ever going live', async () => {
    const b = await make({ startsAt: iso(2 * DAY), endsAt: iso(9 * DAY) })
    await send('post', ops, `/banners/${b.id}/publish`)
    await db.updateTable('banners').set({ starts_at: new Date(Date.now() - 3 * DAY), ends_at: new Date(Date.now() - DAY) }).where('id', '=', b.id).execute()
    await runBannerLifecycle()
    expect(((await get(ops, `/banners/${b.id}`)).body.data as Banner).status).toBe('expired')
  })
})

describe('delete', () => {
  it('soft-deletes a non-active banner and audits it', async () => {
    const b = await make()
    const res = await send('delete', ops, `/banners/${b.id}`)
    expect(res.status).toBe(204)
    expect((await get(ops, `/banners/${b.id}`)).status).toBe(404)
    const row = await db.selectFrom('banners').select(['deleted_at', 'deleted_by']).where('id', '=', b.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    expect(row.deleted_by).toBe(ops.id)
    expect(await auditActions(b.id)).toContain('banner.deleted')
    expect((await send('delete', ops, `/banners/${b.id}`)).status).toBe(404)
  })

  it('refuses to delete an active banner (409) until it is paused', async () => {
    const live = await makeLive()
    const res = await send('delete', ops, `/banners/${live.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Pause the banner before deleting it.' })
    await send('post', ops, `/banners/${live.id}/pause`)
    expect((await send('delete', ops, `/banners/${live.id}`)).status).toBe(204)
  })

  it('can delete scheduled and paused banners; malformed id is 404', async () => {
    const b = await make({ startsAt: iso(DAY), endsAt: iso(4 * DAY) })
    await send('post', ops, `/banners/${b.id}/publish`)
    expect((await send('delete', ops, `/banners/${b.id}`)).status).toBe(204)
    expect((await send('delete', ops, '/banners/not-a-uuid')).status).toBe(404)
  })
})

describe('reorder', () => {
  it('sets priority from the order given, highest first, and returns the placement', async () => {
    const [x, y, z] = [await make({ placement: 'teacher_dashboard' }), await make({ placement: 'teacher_dashboard' }), await make({ placement: 'teacher_dashboard' })]
    const res = await send('post', ops, '/banners/reorder', { placement: 'teacher_dashboard', ids: [z!.id, x!.id, y!.id] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const mine = (res.body.data as Banner[]).filter((b) => [x!.id, y!.id, z!.id].includes(b.id))
    expect(mine.map((b) => [b.id, b.priority])).toEqual([[z!.id, 100], [x!.id, 99], [y!.id, 98]])
    const entry = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'banner.reordered').orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow()
    expect(entry.new_values).toMatchObject({ placement: 'teacher_dashboard', order: [z!.id, x!.id, y!.id] })
  })

  it('rejects banners from another placement, unknown ids, duplicates and an empty list (422)', async () => {
    const home = await make({ placement: 'home_top' })
    const dash = await make({ placement: 'institute_dashboard' })
    expect((await send('post', ops, '/banners/reorder', { placement: 'institute_dashboard', ids: [dash.id, home.id] })).status).toBe(422)
    expect((await send('post', ops, '/banners/reorder', { placement: 'institute_dashboard', ids: [dash.id, randomUUID()] })).status).toBe(422)
    expect((await send('post', ops, '/banners/reorder', { placement: 'institute_dashboard', ids: [dash.id, dash.id] })).status).toBe(422)
    expect((await send('post', ops, '/banners/reorder', { placement: 'institute_dashboard', ids: [] })).status).toBe(422)
    expect((await send('post', ops, '/banners/reorder', { placement: 'nowhere', ids: [dash.id] })).status).toBe(422)
    expect(((await get(ops, `/banners/${dash.id}`)).body.data as Banner).priority).toBe(0)
  })
})

describe('serving to the app', () => {
  it('serves only active banners in their window for the audience and city, best first, at most five', async () => {
    const placement = 'institute_dashboard'
    const mk = (over: Body) => makeLive({ placement, audience: 'institutes', ...over })
    const top = await mk({ title: tag('Serve top'), priority: 80 })
    const low = await mk({ title: tag('Serve low'), priority: 10 })
    const bengaluru = await mk({ title: tag('Serve city A'), priority: 60, cityIds: [cityA.id] })
    const everyone = await mk({ title: tag('Serve all'), audience: 'all', priority: 5 })
    const parentsOnly = await mk({ title: tag('Serve parents'), audience: 'parents', priority: 99 })
    const draft = await make({ placement, audience: 'institutes', priority: 99 })
    const paused = await mk({ priority: 99 })
    await send('post', ops, `/banners/${paused.id}/pause`)
    const future = await make({ placement, audience: 'institutes', startsAt: iso(DAY), endsAt: iso(5 * DAY), priority: 99 })
    await send('post', ops, `/banners/${future.id}/publish`)

    const all = await serve(placement, '&audience=institutes')
    expect(all.status).toBe(200)
    const got = (all.body.data as { id: string }[]).map((b) => b.id)
    for (const hidden of [parentsOnly.id, draft.id, paused.id, future.id, bengaluru.id]) expect(got).not.toContain(hidden)
    expect(got.indexOf(top.id)).toBeLessThan(got.indexOf(low.id))
    expect(got).toEqual(expect.arrayContaining([top.id, low.id, everyone.id]))
    expect(all.body.data[0]).toEqual({ id: expect.any(String), title: expect.any(String), subtitle: null, imageUrl: expect.stringContaining('/banners/'), deepLink: null, placement })

    const inCity = (await serve(placement, `&audience=institutes&cityId=${cityA.id}`)).body.data.map((b: { id: string }) => b.id)
    expect(inCity).toContain(bengaluru.id)
    expect(inCity.indexOf(top.id)).toBeLessThan(inCity.indexOf(bengaluru.id))
    const otherCity = (await serve(placement, `&audience=institutes&cityId=${cityB.id}`)).body.data.map((b: { id: string }) => b.id)
    expect(otherCity).not.toContain(bengaluru.id)

    // Signed out and without an audience: only "all" banners.
    const anon = (await serve(placement)).body.data.map((b: { id: string }) => b.id)
    expect(anon).toContain(everyone.id)
    expect(anon).not.toContain(top.id)

    for (let i = 0; i < 6; i++) await mk({ priority: 20 + i })
    expect((await serve(placement, '&audience=institutes')).body.data).toHaveLength(5)
  })

  it('reflects a change at once: the cache is purged on every banner change', async () => {
    const placement = 'onboarding'
    const b = await makeLive({ placement, audience: 'all', title: tag('Cached') })
    const has = async () => ((await serve(placement)).body.data as { id: string }[]).some((x) => x.id === b.id)
    expect(await has()).toBe(true)
    await send('post', ops, `/banners/${b.id}/pause`)
    expect(await has()).toBe(false)
    await send('post', ops, `/banners/${b.id}/resume`)
    expect(await has()).toBe(true)
    await send('post', ops, `/banners/${b.id}/pause`)
    await send('delete', ops, `/banners/${b.id}`)
    expect(await has()).toBe(false)
  })

  it('validates the query', async () => {
    expect((await request(app).get(`${APP_API}/banners`)).status).toBe(422)
    expect((await serve('nowhere')).status).toBe(422)
    expect((await serve('home_top', '&cityId=x')).status).toBe(422)
    expect((await serve('home_top', '&audience=admins')).status).toBe(422)
  })

  it('serves a signed-in user for their own role, ignoring a spoofed audience', async () => {
    const { createParent, loadMasters, bearer, deleteParent } = await import('../../test/appHelpers.js')
    const masters = await loadMasters()
    const parent = await createParent(masters)
    try {
      const mineB = await makeLive({ placement: 'search_inline', audience: 'parents', title: tag('Parents see') })
      const teachersB = await makeLive({ placement: 'search_inline', audience: 'teachers', title: tag('Teachers see') })
      const res = await request(app).get(`${APP_API}/banners?placement=search_inline&audience=teachers`).set(bearer(parent))
      const got = (res.body.data as { id: string }[]).map((b) => b.id)
      expect(got).toContain(mineB.id)
      expect(got).not.toContain(teachersB.id)
    } finally {
      await deleteParent(parent)
    }
  })
})

describe('preview', () => {
  it('shows what an audience and city would see in every placement', async () => {
    const b = await makeLive({ placement: 'home_middle', audience: 'students', cityIds: [cityA.id], title: tag('Preview') })
    const res = await get(ops, `/banners/preview?audience=students&cityId=${cityA.id}`)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.data.placements).sort()).toEqual(['home_middle', 'home_top', 'institute_dashboard', 'onboarding', 'search_inline', 'teacher_dashboard'])
    expect(res.body.data.placements.home_middle.map((x: { id: string }) => x.id)).toContain(b.id)
    const elsewhere = await get(ops, `/banners/preview?audience=students&cityId=${cityB.id}`)
    expect(elsewhere.body.data.placements.home_middle.map((x: { id: string }) => x.id)).not.toContain(b.id)
    const wrongAudience = await get(ops, '/banners/preview?audience=teachers')
    expect(wrongAudience.body.data.placements.home_middle.map((x: { id: string }) => x.id)).not.toContain(b.id)
  })

  it('validates the audience and city', async () => {
    expect((await get(ops, '/banners/preview?audience=all')).status).toBe(422)
    expect((await get(ops, '/banners/preview?cityId=x')).status).toBe(422)
  })
})

describe('events', () => {
  const post = (events: object[], ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`) => request(app).post(`${APP_API}/events`).set('X-Forwarded-For', ip).send({ events })

  it('adds impressions and clicks to the banner and shows the click-through rate', async () => {
    const b = await makeLive()
    const res = await post([
      ...Array.from({ length: 8 }, () => ({ bannerId: b.id, type: 'impression' })),
      { bannerId: b.id, type: 'click' },
      { bannerId: b.id, type: 'click' },
    ])
    expect(res.status).toBe(202)
    expect(res.body.data).toEqual({ received: 10, counted: 10 })
    expect((await get(ops, `/banners/${b.id}`)).body.data).toMatchObject({ impressions: 8, clicks: 2, ctrPct: 25 })
    await post([{ bannerId: b.id, type: 'impression' }, { bannerId: b.id, type: 'impression' }])
    expect((await get(ops, `/banners/${b.id}`)).body.data).toMatchObject({ impressions: 10, clicks: 2, ctrPct: 20 })
  })

  it('ignores unknown, deleted and draft banners without failing the batch', async () => {
    const live = await makeLive()
    const draft = await make()
    const gone = await make()
    await send('delete', ops, `/banners/${gone.id}`)
    const res = await post([{ bannerId: randomUUID(), type: 'impression' }, { bannerId: draft.id, type: 'click' }, { bannerId: gone.id, type: 'impression' }, { bannerId: live.id, type: 'impression' }])
    expect(res.status).toBe(202)
    expect(res.body.data).toEqual({ received: 4, counted: 1 })
    expect(((await get(ops, `/banners/${draft.id}`)).body.data as Banner).clicks).toBe(0)
  })

  it('validates the batch (422) and rate limits one caller (429)', async () => {
    const b = await makeLive()
    expect((await post([])).status).toBe(422)
    expect((await post([{ bannerId: 'x', type: 'click' }])).status).toBe(422)
    expect((await post([{ bannerId: b.id, type: 'tap' }])).status).toBe(422)
    expect((await post(Array.from({ length: 201 }, () => ({ bannerId: b.id, type: 'impression' })))).status).toBe(422)
    const ip = '10.77.77.77'
    let last = 202
    for (let i = 0; i < 61; i++) last = (await post([{ bannerId: b.id, type: 'impression' }], ip)).status
    expect(last).toBe(429)
  })
})
