import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { APP, bearer, createParent, createTeacher, loadMasters, purgeUsersByPhone } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../../test/appHelpers.js'
import { istToday, pausedUntil } from './availability.service.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent
let requester: TestParent

const DAY = 86_400_000
const plusDays = (n: number) => new Date(Date.parse(`${istToday()}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

async function newTeacher(): Promise<TestTeacher> {
  const t = await createTeacher(m)
  phones.push(t.phone)
  await db.insertInto('teacher_teaching_modes').values([{ teacher_id: t.teacherId, teaching_mode_id: m.modes.online }, { teacher_id: t.teacherId, teaching_mode_id: m.modes.home }]).execute()
  return t
}
const api = (t: { token: string }) => ({
  get: (p: string) => request(app).get(`${APP}${p}`).set(bearer(t)),
  put: (p: string, b: object) => request(app).put(`${APP}${p}`).set(bearer(t)).send(b),
  post: (p: string, b: object, key?: string) => {
    const r = request(app).post(`${APP}${p}`).set(bearer(t))
    return (key ? r.set('Idempotency-Key', key) : r).send(b)
  },
  del: (p: string) => request(app).delete(`${APP}${p}`).set(bearer(t)),
})
const win = (dayOfWeek: number, startTime: string, endTime: string, extra: object = {}) => ({ dayOfWeek, startTime, endTime, acceptsDemos: true, ...extra })

// A demo of `requester` with `teacher`, starting at the given instant.
async function addDemo(teacherId: string, startAt: Date, status: 'requested' | 'confirmed' | 'reschedule_proposed' | 'completed' = 'confirmed') {
  const lead = await db
    .insertInto('leads')
    .values({ lead_type: 'demo', target_type: 'teacher', teacher_id: teacherId, requester_user_id: requester.userId, requester_type: 'parent' } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
  return db
    .insertInto('demo_requests')
    .values({ lead_id: lead.id, teacher_id: teacherId, requester_user_id: requester.userId, requested_start_at: startAt, confirmed_start_at: status === 'requested' ? null : startAt, status })
    .returning('id')
    .executeTakeFirstOrThrow()
}
// 12:00 IST on a given IST date
const noonIst = (isoDate: string) => new Date(Date.parse(`${isoDate}T12:00:00Z`) - 5.5 * 3_600_000)

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
  requester = await createParent(m, { fullName: 'Lakshmi Venkatesh' })
  phones.push(parent.phone, requester.phone)
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('PUT /teacher/availability', () => {
  it('replaces the weekly set, mapping Sunday=0 to the stored ISO day (T19.1)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const res = await c.put('/teacher/availability', { items: [win(1, '18:00', '21:00', { teachingModeId: m.modes.online }), win(1, '09:00', '10:00'), win(0, '10:00', '13:00', { teachingModeId: m.modes.home, acceptsDemos: false })] })
    expect(res.status).toBe(200)
    expect(res.body.data.windows.map((w: { dayOfWeek: number; startTime: string }) => [w.dayOfWeek, w.startTime])).toEqual([[1, '09:00'], [1, '18:00'], [0, '10:00']]) // ordered by ISO day, so Sunday comes last
    expect(res.body.data.windows.find((w: { startTime: string }) => w.startTime === '18:00')).toMatchObject({ teachingMode: 'Online', acceptsDemos: true })
    expect(res.body.data.windows.find((w: { dayOfWeek: number }) => w.dayOfWeek === 0)).toMatchObject({ teachingMode: 'Home tuition', acceptsDemos: false })
    const rows = await db.selectFrom('teacher_availability').select('day_of_week').where('teacher_id', '=', t.teacherId).where('deleted_at', 'is', null).orderBy('day_of_week').execute()
    expect(rows.map((r) => r.day_of_week)).toEqual([1, 1, 7])

    // second save: keep one, change it, drop the others, add a new one
    const second = await c.put('/teacher/availability', { items: [win(1, '18:00', '21:00', { acceptsDemos: false }), win(3, '16:00', '17:00')] })
    expect(second.body.data.windows).toHaveLength(2)
    expect(second.body.data.windows[0]).toMatchObject({ dayOfWeek: 1, startTime: '18:00', teachingMode: null, acceptsDemos: false })
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_availability_set').orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ windowCount: 2 })
    expect((await c.get('/teacher/availability')).body.data.windows).toHaveLength(2)
  })

  it('clears everything with an empty set', async () => {
    const t = await newTeacher()
    await api(t).put('/teacher/availability', { items: [win(2, '10:00', '11:00')] })
    expect((await api(t).put('/teacher/availability', { items: [] })).body.data.windows).toEqual([])
  })

  it('rejects overlaps on the same day regardless of mode, but allows touching windows', async () => {
    const t = await newTeacher()
    const c = api(t)
    const overlap = await c.put('/teacher/availability', { items: [win(1, '18:00', '20:00', { teachingModeId: m.modes.online }), win(1, '19:00', '21:00', { teachingModeId: m.modes.home })] })
    expect(overlap.status).toBe(422)
    expect(overlap.body.error.details[0].message).toBe('This overlaps another window on the same day')
    expect((await c.put('/teacher/availability', { items: [win(1, '18:00', '20:00'), win(1, '20:00', '21:00'), win(2, '18:00', '20:00')] })).status).toBe(200)
    expect((await c.get('/teacher/availability')).body.data.windows).toHaveLength(3)
  })

  it('rejects more than 5 windows in a day before writing anything', async () => {
    const t = await newTeacher()
    await api(t).put('/teacher/availability', { items: [win(4, '08:00', '09:00')] })
    const six = Array.from({ length: 6 }, (_, i) => win(2, `${8 + i * 2}:00`.padStart(5, '0'), `${9 + i * 2}:00`.padStart(5, '0')))
    const res = await api(t).put('/teacher/availability', { items: six })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].reason).toBe('max_windows_per_day')
    expect((await api(t).get('/teacher/availability')).body.data.windows).toHaveLength(1) // untouched
  })

  it('validates days, times, length and teaching mode', async () => {
    const t = await newTeacher()
    const other = await db.selectFrom('teaching_modes').select('id').where('code', '=', 'BATCH').executeTakeFirstOrThrow()
    for (const item of [
      win(7, '10:00', '11:00'),
      win(-1, '10:00', '11:00'),
      win(1, '25:00', '26:00'),
      win(1, '10:0', '11:00'),
      win(1, '11:00', '10:00'),
      win(1, '10:00', '10:00'),
      win(1, '10:00', '10:20'),
      win(1, '10:00', '11:00', { teachingModeId: other.id }), // not one of this teacher's modes
      win(1, '10:00', '11:00', { teachingModeId: randomUUID() }),
    ]) {
      const res = await api(t).put('/teacher/availability', { items: [item] })
      expect(res.status, JSON.stringify(item)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect((await api(t).put('/teacher/availability', { items: [win(1, '10:00', '10:30')] })).status).toBe(200) // exactly 30 minutes
    expect((await api(t).put('/teacher/availability', {})).status).toBe(422)
  })

  it('is teacher-only and scoped to the caller', async () => {
    expect((await request(app).put(`${APP}/teacher/availability`).set(bearer(parent)).send({ items: [] })).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/availability`)).status).toBe(401)
    const a = await newTeacher()
    const b = await newTeacher()
    await api(a).put('/teacher/availability', { items: [win(1, '10:00', '11:00')] })
    expect((await api(b).get('/teacher/availability')).body.data.windows).toEqual([])
  })
})

describe('time off', () => {
  it('adds a range with no clashes and lists it (T19.2)', async () => {
    const t = await newTeacher()
    const res = await api(t).post('/teacher/time-off', { startsOn: plusDays(3), endsOn: plusDays(12), reason: 'Family trip', pauseLeads: true })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ startsOn: plusDays(3), endsOn: plusDays(12), reason: 'Family trip', pauseLeads: true, cancelledDemoCount: 0 })
    expect((await api(t).get('/teacher/time-off')).body.data).toEqual([{ id: res.body.data.id, startsOn: plusDays(3), endsOn: plusDays(12), reason: 'Family trip', pauseLeads: true }])
    expect((await api(t).get('/teacher/availability')).body.data.timeOff).toHaveLength(1)
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_time_off_added').executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ startsOn: plusDays(3), endsOn: plusDays(12), pauseLeads: true, cancelledDemoCount: 0 })
  })

  it('lists the clashing demos first, and cancels them only with confirmForce (T19.3)', async () => {
    const t = await newTeacher()
    const inside = await addDemo(t.teacherId, noonIst(plusDays(5)), 'confirmed')
    const proposed = await addDemo(t.teacherId, noonIst(plusDays(6)), 'reschedule_proposed')
    const outside = await addDemo(t.teacherId, noonIst(plusDays(20)), 'confirmed')
    const done = await addDemo(t.teacherId, noonIst(plusDays(5)), 'completed')
    const body = { startsOn: plusDays(4), endsOn: plusDays(10), pauseLeads: false }

    const clash = await api(t).post('/teacher/time-off', body)
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('CONFLICT_STATE')
    expect(clash.body.error.details.affectedDemos).toEqual([
      { demoId: inside.id, requesterName: 'Lakshmi V.', startAt: noonIst(plusDays(5)).toISOString() },
      { demoId: proposed.id, requesterName: 'Lakshmi V.', startAt: noonIst(plusDays(6)).toISOString() },
    ])
    expect((await api(t).get('/teacher/time-off')).body.data).toEqual([]) // nothing was written
    expect((await db.selectFrom('demo_requests').select('status').where('id', '=', inside.id).executeTakeFirstOrThrow()).status).toBe('confirmed')

    const forced = await api(t).post('/teacher/time-off', { ...body, confirmForce: true })
    expect(forced.status).toBe(201)
    expect(forced.body.data.cancelledDemoCount).toBe(2)
    const rows = await db.selectFrom('demo_requests').select(['id', 'status', 'cancelled_by', 'cancel_reason']).where('teacher_id', '=', t.teacherId).execute()
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by[inside.id]).toMatchObject({ status: 'cancelled', cancelled_by: 'teacher', cancel_reason: 'Teacher marked this period as time off' })
    expect(by[proposed.id]!.status).toBe('cancelled')
    expect(by[outside.id]!.status).toBe('confirmed')
    expect(by[done.id]!.status).toBe('completed')
    // the lead stays open and the requester hears about it
    const lead = await db.selectFrom('leads').select('status').where('teacher_id', '=', t.teacherId).where('id', '=', (await db.selectFrom('demo_requests').select('lead_id').where('id', '=', inside.id).executeTakeFirstOrThrow()).lead_id).executeTakeFirstOrThrow()
    expect(lead.status).toBe('new')
    const notes = await db.selectFrom('user_notifications').select(['event_type', 'deep_link', 'category']).where('user_id', '=', requester.userId).where('event_type', '=', 'demo.cancelled_by_teacher').execute()
    expect(notes).toHaveLength(2)
    expect(notes.map((n) => n.deep_link).sort()).toEqual([`gc://demos/${inside.id}`, `gc://demos/${proposed.id}`].sort())
    expect(notes[0]!.category).toBe('demos')
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_time_off_added').executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ cancelledDemoCount: 2 })
  })

  it('treats the range inclusively in IST', async () => {
    const t = await newTeacher()
    const lastDayLate = new Date(Date.parse(`${plusDays(8)}T23:30:00Z`) - 5.5 * 3_600_000) // 23:30 IST on the last day
    const nextDay = new Date(Date.parse(`${plusDays(9)}T00:30:00Z`) - 5.5 * 3_600_000) // 00:30 IST the day after
    await addDemo(t.teacherId, lastDayLate)
    await addDemo(t.teacherId, nextDay)
    const clash = await api(t).post('/teacher/time-off', { startsOn: plusDays(7), endsOn: plusDays(8), pauseLeads: false })
    expect(clash.body.error.details.affectedDemos).toHaveLength(1)
  })

  it('replays the same response for the same Idempotency-Key', async () => {
    const t = await newTeacher()
    const key = randomUUID()
    const body = { startsOn: plusDays(2), endsOn: plusDays(3), pauseLeads: false }
    const a = await api(t).post('/teacher/time-off', body, key)
    const b = await api(t).post('/teacher/time-off', body, key)
    expect(b.body.data).toEqual(a.body.data)
    expect((await api(t).get('/teacher/time-off')).body.data).toHaveLength(1)
  })

  it('validates the dates (T19.9, T19.10)', async () => {
    const t = await newTeacher()
    for (const body of [
      { startsOn: plusDays(5), endsOn: plusDays(4), pauseLeads: false }, // ends before it starts
      { startsOn: plusDays(1), endsOn: plusDays(92), pauseLeads: false }, // > 90 days
      { startsOn: plusDays(-1), endsOn: plusDays(3), pauseLeads: false }, // starts in the past
      { startsOn: 'next week', endsOn: plusDays(3), pauseLeads: false },
      { startsOn: plusDays(1), endsOn: plusDays(2), pauseLeads: false, reason: 'x'.repeat(201) },
      { startsOn: plusDays(1), endsOn: plusDays(2) }, // pauseLeads is required
    ]) {
      const res = await api(t).post('/teacher/time-off', body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect((await api(t).post('/teacher/time-off', { startsOn: plusDays(1), endsOn: plusDays(91), pauseLeads: false })).status).toBe(201) // exactly 90 days apart
    expect((await api(t).post('/teacher/time-off', { startsOn: plusDays(100), endsOn: plusDays(100), pauseLeads: false })).status).toBe(201) // a single day
  })

  it('rejects overlapping ranges and an eleventh active range (T19.6)', async () => {
    const t = await newTeacher()
    const c = api(t)
    expect((await c.post('/teacher/time-off', { startsOn: plusDays(10), endsOn: plusDays(12), pauseLeads: false })).status).toBe(201)
    for (const [s, e] of [[10, 12], [11, 11], [12, 14], [8, 10]] as const) {
      const res = await c.post('/teacher/time-off', { startsOn: plusDays(s), endsOn: plusDays(e), pauseLeads: false })
      expect(res.status, `${s}-${e}`).toBe(422)
      expect(res.body.error.details[0].message).toBe('You already have time off marked for these dates')
    }
    expect((await c.post('/teacher/time-off', { startsOn: plusDays(13), endsOn: plusDays(14), pauseLeads: false })).status).toBe(201) // adjacent is fine
    for (let i = 2; i < 10; i++) expect((await c.post('/teacher/time-off', { startsOn: plusDays(20 + i * 3), endsOn: plusDays(21 + i * 3), pauseLeads: false })).status).toBe(201)
    const eleventh = await c.post('/teacher/time-off', { startsOn: plusDays(80), endsOn: plusDays(81), pauseLeads: false })
    expect(eleventh.status).toBe(422)
    expect(eleventh.body.error.details[0].reason).toBe('max_time_off')

    // an elapsed range no longer counts, and deleting one frees a slot
    const list = (await c.get('/teacher/time-off')).body.data as { id: string }[]
    expect(list).toHaveLength(10)
    expect((await c.del(`/teacher/time-off/${list[0]!.id}`)).status).toBe(200)
    expect((await c.post('/teacher/time-off', { startsOn: plusDays(80), endsOn: plusDays(81), pauseLeads: false })).status).toBe(201)
  })

  it('ignores expired ranges for the cap and the list', async () => {
    const t = await newTeacher()
    for (let i = 0; i < 10; i++) {
      await db.insertInto('teacher_time_off').values({ teacher_id: t.teacherId, starts_on: plusDays(-30 - i * 3), ends_on: plusDays(-29 - i * 3) }).execute()
    }
    expect((await api(t).get('/teacher/time-off')).body.data).toEqual([])
    expect((await api(t).post('/teacher/time-off', { startsOn: plusDays(1), endsOn: plusDays(2), pauseLeads: false })).status).toBe(201)
  })

  it('removes a range early and leaves cancelled demos cancelled (T19.5)', async () => {
    const t = await newTeacher()
    const demo = await addDemo(t.teacherId, noonIst(plusDays(5)))
    const created = await api(t).post('/teacher/time-off', { startsOn: plusDays(4), endsOn: plusDays(6), pauseLeads: true, confirmForce: true })
    const del = await api(t).del(`/teacher/time-off/${created.body.data.id}`)
    expect(del.status).toBe(200)
    expect((await api(t).get('/teacher/availability')).body.data.timeOff).toEqual([])
    expect(await db.selectFrom('teacher_time_off').select('id').where('id', '=', created.body.data.id).execute()).toHaveLength(0)
    expect((await db.selectFrom('demo_requests').select('status').where('id', '=', demo.id).executeTakeFirstOrThrow()).status).toBe('cancelled')
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_time_off_removed').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ startsOn: plusDays(4), endsOn: plusDays(6) })
  })

  it("404s for a missing or someone else's range and a malformed id", async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    const created = await api(a).post('/teacher/time-off', { startsOn: plusDays(2), endsOn: plusDays(3), pauseLeads: false })
    const foreign = await api(b).del(`/teacher/time-off/${created.body.data.id}`)
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe('NOT_FOUND')
    expect((await api(a).del(`/teacher/time-off/${randomUUID()}`)).status).toBe(404)
    expect((await api(a).del('/teacher/time-off/nope')).status).toBe(422)
    expect((await api(a).get('/teacher/time-off')).body.data).toHaveLength(1)
  })

  it('exposes who is away with leads paused for the modules that enforce it (BR-19.4)', async () => {
    const t = await newTeacher()
    expect(await pausedUntil(t.teacherId)).toBeNull()
    await api(t).post('/teacher/time-off', { startsOn: plusDays(2), endsOn: plusDays(4), pauseLeads: true })
    expect(await pausedUntil(t.teacherId)).toBeNull() // not started yet
    const todayRange = await db.insertInto('teacher_time_off').values({ teacher_id: t.teacherId, starts_on: plusDays(-1), ends_on: plusDays(1), pause_leads: true }).returning('id').executeTakeFirstOrThrow()
    expect(await pausedUntil(t.teacherId)).toBe(plusDays(1))
    await db.updateTable('teacher_time_off').set({ pause_leads: false }).where('id', '=', todayRange.id).execute()
    expect(await pausedUntil(t.teacherId)).toBeNull() // pauseLeads false only blocks demo slots
  })

  it('is teacher-only', async () => {
    expect((await request(app).post(`${APP}/teacher/time-off`).set(bearer(parent)).send({ startsOn: plusDays(1), endsOn: plusDays(2), pauseLeads: false })).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/time-off`)).status).toBe(401)
  })
})
