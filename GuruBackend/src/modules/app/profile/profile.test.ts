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

async function newParent(overrides: Parameters<typeof createParent>[1] = {}) {
  const p = await createParent(m, overrides)
  parents.push(p)
  return p
}

const get = (p: TestParent) => request(app).get(`${APP}/parent/profile`).set(bearer(p))
const patch = (p: TestParent, body: Record<string, unknown>, version?: string) => {
  const req = request(app).patch(`${APP}/parent/profile`).set(bearer(p))
  if (version !== undefined) req.set('If-Match', version)
  return req.send(body)
}

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  for (const p of parents) await deleteParent(p)
  await closeRedis()
  await pool.end()
})

describe('auth', () => {
  it('requires a bearer token', async () => {
    expect((await request(app).get(`${APP}/parent/profile`)).status).toBe(401)
    expect((await request(app).patch(`${APP}/parent/profile`).send({})).status).toBe(401)
  })

  it('rejects a non-parent account (FORBIDDEN)', async () => {
    const teacher = await newParent({ role: 'teacher' })
    const res = await get(teacher)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await patch(teacher, { fullName: 'Someone Else' }, new Date().toISOString())).status).toBe(403)
  })
})

describe('GET /parent/profile', () => {
  it('returns the profile with masked contact details, location and counts', async () => {
    const p = await newParent()
    const res = await get(p)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      id: p.parentId,
      publicCode: expect.stringMatching(/^GC-P\d+$/),
      fullName: 'Lakshmi Venkatesh',
      photoUrl: null,
      phoneMasked: `+91 ${p.phone.slice(3, 8)} XXXXX`,
      emailMasked: expect.stringMatching(/^l\*\*\*.@example\.com$/),
      city: { id: m.city.id, name: m.city.name },
      area: { id: m.areas[0]!.id, name: m.areas[0]!.name },
      childrenCount: 0,
      unreadNotifications: 0,
    })
    expect(res.body.data.memberSince).toEqual(expect.any(String))
    expect(res.body.data.updatedAt).toEqual(expect.any(String))
    // Never leaks the raw contact details.
    expect(JSON.stringify(res.body)).not.toContain(p.phone)
    expect(JSON.stringify(res.body)).not.toContain(p.email)
  })

  it('returns null city/area when the parent has none', async () => {
    const p = await newParent({ cityId: null, areaId: null })
    const res = await get(p)
    expect(res.body.data.city).toBeNull()
    expect(res.body.data.area).toBeNull()
  })

  it('counts live children only', async () => {
    const p = await newParent()
    const a = await db.insertInto('parent_children').values({ parent_id: p.parentId, child_name: 'Aarav', class_id: m.classes.five }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('parent_children').values({ parent_id: p.parentId, child_name: 'Riya', class_id: m.classes.five, deleted_at: new Date() }).execute()
    expect((await get(p)).body.data.childrenCount).toBe(1)
    await db.deleteFrom('parent_children').where('id', '=', a.id).execute()
  })

  it('counts unread, non-deleted, non-expired notifications only', async () => {
    const p = await newParent()
    const base = { user_id: p.userId, category: 'announcements', event_type: 'test', title: 't', body: 'b' }
    await db
      .insertInto('user_notifications')
      .values([
        base,
        base,
        { ...base, read_at: new Date() },
        { ...base, deleted_at: new Date() },
        { ...base, expires_at: new Date(Date.now() - 60_000) },
        { ...base, expires_at: new Date(Date.now() + 3_600_000) },
      ])
      .execute()
    expect((await get(p)).body.data.unreadNotifications).toBe(3)
  })

  it('builds photoUrl from the CDN and the avatar file', async () => {
    const p = await newParent()
    const file = await db
      .insertInto('files' as never)
      .values({
        storage_provider: 's3',
        bucket: 'gc-public',
        object_key: `avatars/${randomUUID()}.jpg`,
        original_name: 'me.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1234,
        visibility: 'public',
        purpose: 'avatar',
        uploaded_by_type: 'app_user',
        uploaded_by_id: p.userId,
        status: 'uploaded',
      } as never)
      .returning('object_key' as never)
      .executeTakeFirstOrThrow()
    await db.updateTable('app_users').set({ profile_photo_file_id: (await db.selectFrom('files').select('id').where('object_key', '=', (file as { object_key: string }).object_key).executeTakeFirstOrThrow()).id }).where('id', '=', p.userId).execute()

    const res = await get(p)
    expect(res.body.data.photoUrl).toBe(`${env.CDN_BASE_URL}/${(file as { object_key: string }).object_key}`)

    await db.updateTable('app_users').set({ profile_photo_file_id: null }).where('id', '=', p.userId).execute()
    await db.deleteFrom('files').where('object_key', '=', (file as { object_key: string }).object_key).execute()
  })
})

describe('PATCH /parent/profile', () => {
  it('requires If-Match', async () => {
    const p = await newParent()
    const res = await patch(p, { fullName: 'Lakshmi V' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect((await patch(p, { fullName: 'Lakshmi V' }, 'garbage')).status).toBe(422)
  })

  it('updates the name, returns the M09 response shape and keeps /me in step', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const res = await patch(p, { fullName: '  Lakshmi   Iyer-Rao ' }, before.updatedAt)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      id: p.parentId,
      fullName: 'Lakshmi Iyer-Rao',
      photoUrl: null,
      city: { id: m.city.id, name: m.city.name },
      area: { id: m.areas[0]!.id, name: m.areas[0]!.name },
      updatedAt: expect.any(String),
    })
    expect(res.body.data.updatedAt).not.toBe(before.updatedAt)

    const me = await request(app).get(`${APP}/me`).set(bearer(p))
    expect(me.body.data.name).toBe('Lakshmi Iyer-Rao')
    const audit = await db.selectFrom('audit_logs').select(['new_values', 'module']).where('action', '=', 'app.parent_profile_updated').where('entity_id', '=', p.parentId).executeTakeFirstOrThrow()
    expect(audit).toMatchObject({ module: 'app.parent_profile', new_values: { changedFields: ['fullName'] } })
  })

  it('accepts a quoted If-Match', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    expect((await patch(p, { fullName: 'Lakshmi V' }, `"${before.updatedAt}"`)).status).toBe(200)
  })

  it('returns 409 VERSION_CONFLICT for a stale If-Match and applies nothing', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    expect((await patch(p, { fullName: 'First Edit' }, before.updatedAt)).status).toBe(200)

    const stale = await patch(p, { fullName: 'Second Edit' }, before.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
    expect((await get(p)).body.data.fullName).toBe('First Edit')
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const [a, b] = await Promise.all([patch(p, { fullName: 'Edit Aaa' }, before.updatedAt), patch(p, { fullName: 'Edit Bbb' }, before.updatedAt)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('clears the area when the city changes without a new area, and follows the city to its state', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const res = await patch(p, { cityId: m.otherCity.id }, before.updatedAt)

    expect(res.status).toBe(200)
    expect(res.body.data.city).toEqual({ id: m.otherCity.id, name: m.otherCity.name })
    expect(res.body.data.area).toBeNull()
    const row = await db.selectFrom('parents').select(['city_id', 'area_id', 'state_id']).where('id', '=', p.parentId).executeTakeFirstOrThrow()
    expect(row).toEqual({ city_id: m.otherCity.id, area_id: null, state_id: m.otherCity.state_id })
  })

  it('keeps the area when the same city is sent again', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const res = await patch(p, { cityId: m.city.id }, before.updatedAt)
    expect(res.body.data.area).toEqual({ id: m.areas[0]!.id, name: m.areas[0]!.name })
  })

  it('uses a new area sent together with a new city', async () => {
    const p = await newParent({ cityId: m.otherCity.id, areaId: null, stateId: m.otherCity.state_id })
    const before = (await get(p)).body.data
    const res = await patch(p, { cityId: m.city.id, areaId: m.areas[1]!.id }, before.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.city.id).toBe(m.city.id)
    expect(res.body.data.area).toEqual({ id: m.areas[1]!.id, name: m.areas[1]!.name })
  })

  it('changes and clears the area within the current city', async () => {
    const p = await newParent()
    const first = (await get(p)).body.data
    const changed = await patch(p, { areaId: m.areas[1]!.id }, first.updatedAt)
    expect(changed.body.data.area.id).toBe(m.areas[1]!.id)

    const cleared = await patch(p, { areaId: null }, changed.body.data.updatedAt)
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.area).toBeNull()
  })

  it('rejects an area that belongs to a different city (VALIDATION_FAILED)', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    // Changing to the other city while keeping a Karnataka area id.
    const res = await patch(p, { cityId: m.otherCity.id, areaId: m.areas[0]!.id }, before.updatedAt)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details[0]).toMatchObject({ path: 'areaId' })
    expect(res.body.error.details[0].message).toContain(m.otherCity.name)

    const unknown = await patch(p, { areaId: randomUUID() }, before.updatedAt)
    expect(unknown.status).toBe(422)
    // Nothing was applied by either failed request.
    expect((await get(p)).body.data.city.id).toBe(m.city.id)
  })

  it('rejects an unknown city', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const res = await patch(p, { cityId: randomUUID() }, before.updatedAt)
    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual([{ path: 'cityId', message: 'Choose a city.' }])
  })

  it('validates the full name (2-100 chars, letters/spaces/dot/hyphen)', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    for (const bad of ['', 'A', 'X'.repeat(101), 'Lakshmi 123', 'Lakshmi@V', '   ']) {
      const res = await patch(p, { fullName: bad }, before.updatedAt)
      expect(res.status, `name "${bad}"`).toBe(422)
    }
    expect((await patch(p, { fullName: 'Dr. Lakshmi V-Rao' }, before.updatedAt)).status).toBe(200)
  })

  it('rejects an empty body and malformed ids', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    expect((await patch(p, {}, before.updatedAt)).status).toBe(422)
    expect((await patch(p, { cityId: 'nope' }, before.updatedAt)).status).toBe(422)
    expect((await patch(p, { areaId: 'nope' }, before.updatedAt)).status).toBe(422)
  })

  it('does not let a parent change another parent\'s profile: the id comes from the token only', async () => {
    const a = await newParent()
    const b = await newParent({ fullName: 'Other Parent' })
    const before = (await get(a)).body.data
    await patch(a, { fullName: 'Changed Name', ...({ id: b.parentId } as object) }, before.updatedAt)
    expect((await get(b)).body.data.fullName).toBe('Other Parent')
  })
})
