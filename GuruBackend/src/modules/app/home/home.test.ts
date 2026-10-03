import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { env } from '../../../config/env.js'
import { db, pool } from '../../../db/index.js'
import { closeRedis } from '../../../lib/redis.js'
import { APP, bearer, createParent, deleteParent, loadMasters } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'

const app = createApp()

let m: Masters
const parents: TestParent[] = []
const bannerIds: string[] = []
const fileKeys: string[] = []

async function newParent(overrides: Parameters<typeof createParent>[1] = {}) {
  const p = await createParent(m, overrides)
  parents.push(p)
  return p
}

async function addChild(p: TestParent, name: string, classId: string, sortOrder?: number) {
  return db
    .insertInto('parent_children')
    .values({ parent_id: p.parentId, child_name: name, class_id: classId, ...(sortOrder === undefined ? {} : { sort_order: sortOrder }) })
    .returning('id')
    .executeTakeFirstOrThrow()
}

const home = (p: TestParent, query = '') => request(app).get(`${APP}/home/parent${query}`).set(bearer(p))

async function addBanner(over: Partial<{ title: string; placement: 'home_top' | 'home_middle' | 'search_inline'; audience: 'all' | 'parents' | 'students'; cityIds: string[]; priority: number; status: 'active' | 'draft' | 'paused'; startsAt: Date; endsAt: Date | null; deepLink: string | null; fileStatus: 'uploaded' | 'pending' }> = {}) {
  const objectKey = `banners/${randomUUID()}.webp`
  fileKeys.push(objectKey)
  const file = await db
    .insertInto('files' as never)
    .values({
      storage_provider: 's3',
      bucket: 'gc-public',
      object_key: objectKey,
      original_name: 'b.webp',
      mime_type: 'image/webp',
      size_bytes: 100,
      visibility: 'public',
      purpose: 'banner',
      uploaded_by_type: 'admin',
      status: over.fileStatus ?? 'uploaded',
    } as never)
    .returning('id' as never)
    .executeTakeFirstOrThrow()

  const banner = await db
    .insertInto('banners')
    .values({
      title: over.title ?? 'Board exams in 90 days',
      image_file_id: (file as { id: string }).id,
      placement: over.placement ?? 'home_top',
      audience: over.audience ?? 'parents',
      city_ids: over.cityIds ?? [],
      priority: over.priority ?? 0,
      status: over.status ?? 'active',
      starts_at: over.startsAt ?? new Date(Date.now() - 3_600_000),
      ends_at: over.endsAt === undefined ? null : over.endsAt,
      deep_link: over.deepLink ?? 'gc://search',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  bannerIds.push(banner.id)
  return { id: banner.id, objectKey }
}

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  if (bannerIds.length) await db.deleteFrom('banners').where('id', 'in', bannerIds).execute()
  if (fileKeys.length) await db.deleteFrom('files').where('object_key', 'in', fileKeys).execute()
  for (const p of parents) await deleteParent(p)
  await closeRedis()
  await pool.end()
})

describe('auth', () => {
  it('requires a bearer token', async () => {
    const res = await request(app).get(`${APP}/home/parent`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('rejects a non-parent account (FORBIDDEN)', async () => {
    const teacher = await newParent({ role: 'teacher' })
    const res = await home(teacher)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('GET /home/parent — no children yet', () => {
  it('returns the empty shape: no switcher, per-child rails hidden, the other rails present but empty', async () => {
    const p = await newParent()
    const res = await home(p)

    expect(res.status).toBe(200)
    expect(res.body.data.children).toEqual([])
    expect(res.body.data.selectedChildId).toBeNull()
    expect(res.body.data.banners).toEqual({ home_top: [], home_middle: [] })
    expect(res.body.data.rails.recommended_teachers).toBeNull()
    expect(res.body.data.rails.recommended_institutes).toBeNull()
    for (const code of ['nearby_teachers', 'top_rated_teachers', 'verified_teachers']) {
      expect(res.body.data.rails[code]).toEqual({ items: [], nextCursor: null, cachedAt: expect.any(String) })
    }
    expect(Object.keys(res.body.meta.rails).sort()).toEqual(['nearby_teachers', 'top_rated_teachers', 'verified_teachers'])
  })
})

describe('GET /home/parent — with children', () => {
  it('lists children in sort order with class labels and selects the first by default', async () => {
    const p = await newParent()
    const riya = await addChild(p, 'Riya', m.classes.nine, 1)
    const aarav = await addChild(p, 'Aarav', m.classes.five, 0)
    await db.insertInto('parent_children').values({ parent_id: p.parentId, child_name: 'Gone', class_id: m.classes.five, deleted_at: new Date() }).execute()

    const res = await home(p)
    expect(res.status).toBe(200)
    expect(res.body.data.children).toEqual([
      { id: aarav.id, childName: 'Aarav', classLabel: 'Class 5', sortOrder: 0 },
      { id: riya.id, childName: 'Riya', classLabel: 'Class 9', sortOrder: 1 },
    ])
    expect(res.body.data.selectedChildId).toBe(aarav.id)
  })

  it('includes all five rails as {items, nextCursor, cachedAt} and a per-rail cachedAt in meta', async () => {
    const p = await newParent()
    await addChild(p, 'Aarav', m.classes.five)
    const res = await home(p)

    for (const code of ['recommended_teachers', 'recommended_institutes', 'nearby_teachers', 'top_rated_teachers', 'verified_teachers']) {
      expect(res.body.data.rails[code], code).toEqual({ items: [], nextCursor: null, cachedAt: expect.any(String) })
      expect(res.body.meta.rails[code].cachedAt).toBe(res.body.data.rails[code].cachedAt)
    }
  })

  it('honours ?childId= and reflects it in selectedChildId', async () => {
    const p = await newParent()
    await addChild(p, 'Aarav', m.classes.five, 0)
    const riya = await addChild(p, 'Riya', m.classes.nine, 1)
    const res = await home(p, `?childId=${riya.id}`)
    expect(res.body.data.selectedChildId).toBe(riya.id)
    expect(res.body.data.children).toHaveLength(2)
  })

  it("returns 403 FORBIDDEN for another parent's or a deleted child, and 422 for a malformed id", async () => {
    const a = await newParent()
    const b = await newParent()
    const theirs = await addChild(b, 'Theirs', m.classes.five)
    const deleted = await db.insertInto('parent_children').values({ parent_id: a.parentId, child_name: 'Gone', class_id: m.classes.five, deleted_at: new Date() }).returning('id').executeTakeFirstOrThrow()
    await addChild(a, 'Mine', m.classes.five)

    expect((await home(a, `?childId=${theirs.id}`)).status).toBe(403)
    expect((await home(a, `?childId=${deleted.id}`)).status).toBe(403)
    expect((await home(a, `?childId=${randomUUID()}`)).status).toBe(403)
    const malformed = await home(a, '?childId=not-a-uuid')
    expect(malformed.status).toBe(422)
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('GET /home/parent?rail=', () => {
  it('returns one rail as data.items with meta.nextCursor', async () => {
    const p = await newParent()
    const aarav = await addChild(p, 'Aarav', m.classes.five)
    const res = await home(p, `?rail=recommended_teachers&childId=${aarav.id}&cursor=eyJvIjoyMH0&limit=20`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { items: [] }, meta: { nextCursor: null } })
  })

  it('works for every rail code, with or without a child', async () => {
    const p = await newParent()
    for (const code of ['nearby_teachers', 'top_rated_teachers', 'verified_teachers', 'recommended_teachers', 'recommended_institutes']) {
      const res = await home(p, `?rail=${code}`)
      expect(res.status, code).toBe(200)
      expect(res.body.data.items).toEqual([])
      expect(res.body.meta.nextCursor).toBeNull()
    }
  })

  it('rejects an unknown rail, a bad limit and an oversized cursor', async () => {
    const p = await newParent()
    for (const q of ['?rail=bogus', '?rail=nearby_teachers&limit=0', '?rail=nearby_teachers&limit=21', '?limit=abc', `?rail=nearby_teachers&cursor=${'x'.repeat(201)}`]) {
      const res = await home(p, q)
      expect(res.status, q).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('applies the same child ownership check to a rail page', async () => {
    const a = await newParent()
    const b = await newParent()
    const theirs = await addChild(b, 'Theirs', m.classes.five)
    expect((await home(a, `?rail=recommended_teachers&childId=${theirs.id}`)).status).toBe(403)
  })
})

describe('GET /home/parent — banners', () => {
  it('serves active banners for the parent audience with CDN image URLs', async () => {
    const p = await newParent()
    const b = await addBanner({ title: 'Exam season', priority: 5, deepLink: 'gc://search?classId=1' })
    const res = await home(p)

    const item = res.body.data.banners.home_top.find((x: { id: string }) => x.id === b.id)
    expect(item).toEqual({ id: b.id, title: 'Exam season', subtitle: null, imageUrl: `${env.CDN_BASE_URL}/${b.objectKey}`, deepLink: 'gc://search?classId=1' })
  })

  it('filters by placement, audience, status, window and city', async () => {
    const p = await newParent()
    const shown = await addBanner({ title: 'shown-city', cityIds: [m.city.id] })
    const shownAll = await addBanner({ title: 'shown-all', audience: 'all' })
    const middle = await addBanner({ title: 'shown-middle', placement: 'home_middle' })
    const wrongAudience = await addBanner({ audience: 'students' })
    const wrongCity = await addBanner({ cityIds: [m.otherCity.id] })
    const draft = await addBanner({ status: 'draft' })
    const paused = await addBanner({ status: 'paused' })
    const notStarted = await addBanner({ startsAt: new Date(Date.now() + 3_600_000) })
    const expired = await addBanner({ startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 3_600_000) })
    const otherPlacement = await addBanner({ placement: 'search_inline' })
    const notUploaded = await addBanner({ fileStatus: 'pending' })

    const res = await home(p)
    const top = res.body.data.banners.home_top.map((x: { id: string }) => x.id)
    const mid = res.body.data.banners.home_middle.map((x: { id: string }) => x.id)
    expect(top).toEqual(expect.arrayContaining([shown.id, shownAll.id]))
    expect(mid).toContain(middle.id)
    for (const excluded of [wrongAudience, wrongCity, draft, paused, notStarted, expired, otherPlacement, notUploaded]) {
      expect(top, excluded.objectKey).not.toContain(excluded.id)
      expect(mid).not.toContain(excluded.id)
    }
  })

  it('orders by priority and caps home_top at 3 and home_middle at 2', async () => {
    // A parent in a city no other test targets, so only this test's banners are city-scoped to it.
    const p = await newParent({ cityId: m.otherCity.id, areaId: null, stateId: m.otherCity.state_id })
    const priorities = [10, 40, 30, 20, 50]
    const tops = []
    for (const priority of priorities) tops.push(await addBanner({ cityIds: [m.otherCity.id], priority, title: `top-${priority}` }))
    for (const priority of [1, 2, 3]) await addBanner({ cityIds: [m.otherCity.id], placement: 'home_middle', priority, title: `mid-${priority}` })

    const res = await home(p)
    const titles = (list: { title: string }[]) => list.map((x) => x.title)
    expect(titles(res.body.data.banners.home_top)).toEqual(['top-50', 'top-40', 'top-30'])
    expect(titles(res.body.data.banners.home_middle)).toEqual(['mid-3', 'mid-2'])
    expect(tops).toHaveLength(5)
  })

  it('only serves city-agnostic banners to a parent without a city', async () => {
    const p = await newParent({ cityId: null, areaId: null, stateId: null })
    const cityBanner = await addBanner({ cityIds: [m.city.id] })
    const open = await addBanner({ cityIds: [] })
    const res = await home(p)
    const ids = res.body.data.banners.home_top.map((x: { id: string }) => x.id)
    expect(ids).not.toContain(cityBanner.id)
    expect(ids).toContain(open.id)
  })
})
