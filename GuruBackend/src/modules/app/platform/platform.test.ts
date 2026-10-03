import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { signAppAccessToken } from '../../../lib/appJwt.js'

const app = createApp()
const phone = '+919911100011'

describe('platform module (M00 subset)', () => {
  let userId: string
  let parentId: string
  let accessToken: string

  beforeAll(async () => {
    const user = await db
      .insertInto('app_users')
      .values({ user_type: 'parent', phone, full_name: 'Test Parent', signup_source: 'organic' })
      .returning('id')
      .executeTakeFirstOrThrow()
    userId = user.id

    const parent = await db.insertInto('parents').values({ user_id: userId, full_name: 'Test Parent', phone }).returning('id').executeTakeFirstOrThrow()
    parentId = parent.id

    accessToken = signAppAccessToken({ sub: userId, role: 'parent', pid: parentId, sid: randomUUID() })
  })

  afterAll(async () => {
    await db.deleteFrom('user_devices').where('user_id', '=', userId).execute()
    await db.deleteFrom('parents').where('id', '=', parentId).execute()
    await db.deleteFrom('app_users').where('id', '=', userId).execute()
    await pool.end()
  })

  it('GET /me returns the signed-in user summary', async () => {
    const res = await request(app).get('/api/v1/app/me').set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(userId)
    expect(res.body.data.role).toBe('parent')
    expect(res.body.data.registration.nextStep).toBe('child_setup')
  })

  it('GET /me requires authentication', async () => {
    const res = await request(app).get('/api/v1/app/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('PUT /devices/me upserts a device row', async () => {
    const res = await request(app)
      .put('/api/v1/app/devices/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ installId: randomUUID(), platform: 'android', appVersion: '1.0.0', locale: 'en-IN', timezone: 'Asia/Kolkata' })
    expect(res.status).toBe(200)
    expect(res.body.data.ok).toBe(true)
  })

  it('GET /masters returns states, cities, boards, classes, teachingModes', async () => {
    const res = await request(app).get('/api/v1/app/masters')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.states)).toBe(true)
    expect(res.body.data.states.length).toBeGreaterThan(0)
    expect(Array.isArray(res.body.data.cities)).toBe(true)
  })

  it('GET /masters carries the child-setup masters with their ranges, types and ordering', async () => {
    const res = await request(app).get('/api/v1/app/masters')
    const d = res.body.data

    expect(d.classes[0]).toEqual({ id: expect.any(String), name: 'Class 1', levelOrder: 1 })
    const orders = d.classes.map((c: { levelOrder: number }) => c.levelOrder)
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b))

    const physics = d.subjects.find((s: { name: string }) => s.name === 'Physics')
    expect(physics).toEqual({ id: expect.any(String), name: 'Physics', minClassOrder: 9, maxClassOrder: 14 })
    expect(d.subjects.some((s: { minClassOrder: number | null }) => s.minClassOrder === null || typeof s.minClassOrder === 'number')).toBe(true)

    const cbse = d.boards.find((b: { shortName: string }) => b.shortName === 'CBSE')
    expect(cbse).toEqual({ id: expect.any(String), name: expect.any(String), shortName: 'CBSE', type: 'national', stateId: null })
    const stateBoard = d.boards.find((b: { type: string }) => b.type === 'state')
    expect(stateBoard.stateId).toEqual(expect.any(String))

    expect(d.teacherCategories.length).toBeGreaterThan(0)
    expect(d.teacherCategories[0]).toEqual({ id: expect.any(String), name: expect.any(String) })
    expect(d.teachingModes.length).toBeGreaterThan(0)
    expect(d.teachingModes[0]).toEqual({ id: expect.any(String), name: expect.any(String) })
  })

  it('GET /masters is public (no token needed) and only lists active rows', async () => {
    const res = await request(app).get('/api/v1/app/masters')
    expect(res.status).toBe(200)
    const inactive = await db.selectFrom('subjects').select('id').where('is_active', '=', false).execute()
    const ids = new Set(res.body.data.subjects.map((s: { id: string }) => s.id))
    for (const row of inactive) expect(ids.has(row.id)).toBe(false)
  })

  it("GET /masters/areas?cityId= returns only that city's areas", async () => {
    const masters = await request(app).get('/api/v1/app/masters')
    const cityId = masters.body.data.cities[0].id
    const res = await request(app).get(`/api/v1/app/masters/areas?cityId=${cityId}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.areas)).toBe(true)
    for (const a of res.body.data.areas) expect(a.cityId).toBe(cityId)
  })
})
