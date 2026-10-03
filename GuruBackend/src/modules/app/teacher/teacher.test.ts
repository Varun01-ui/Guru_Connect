import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { env } from '../../../config/env.js'
import { db, pool } from '../../../db/index.js'
import { APP, bearer, createParent, deleteParent, loadMasters, purgeUsersByPhone, randomPhone, registrationToken } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent
let subjectIds: string[]
let classIds: string[]
let modes: { online: string; home: string; offline: string; hybrid: string; batch: string }

const dobFor = (age: number) => `${new Date().getFullYear() - age}-01-15`

const regBody = (over: Record<string, unknown> = {}) => ({ fullName: 'Kavya Menon', gender: 'female', dateOfBirth: dobFor(32), categoryId: m.categories.homeTutor, ...over })

async function register(over: Record<string, unknown> = {}) {
  const phone = randomPhone()
  phones.push(phone)
  const res = await request(app)
    .post(`${APP}/registration/teacher`)
    .set('Authorization', `Bearer ${registrationToken(phone).token}`)
    .set('Idempotency-Key', randomUUID())
    .send(regBody(over))
  expect(res.status).toBe(201)
  return { phone, token: res.body.data.accessToken as string, teacherId: res.body.data.teacherId as string }
}

const api = (t: { token: string }) => ({
  get: (path: string) => request(app).get(`${APP}${path}`).set(bearer(t)),
  post: (path: string, body?: object) => request(app).post(`${APP}${path}`).set(bearer(t)).send(body),
  put: (path: string, body: object) => request(app).put(`${APP}${path}`).set(bearer(t)).send(body),
  del: (path: string) => request(app).delete(`${APP}${path}`).set(bearer(t)),
  patch: (path: string, body: object, version?: string) => {
    const r = request(app).patch(`${APP}${path}`).set(bearer(t))
    return (version ? r.set('If-Match', version) : r).send(body)
  },
})

async function version(t: { token: string }) {
  return (await api(t).get('/teacher/registration')).body.data.teacher.updatedAt as string
}

const qual = (over: Record<string, unknown> = {}) => ({ level: 'postgraduate', degree: 'M.Sc. Physics', institution: 'Bangalore University', yearCompleted: 2010, grade: 'First class', isHighest: true, ...over })
const setStatus = (teacherId: string, status: string) => db.updateTable('teachers').set({ verification_status: status as 'pending' }).where('id', '=', teacherId).execute()

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
  subjectIds = (await db.selectFrom('subjects').select('id').where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('name').limit(12).execute()).map((s) => s.id)
  classIds = (await db.selectFrom('classes').select('id').where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('level_order').execute()).map((c) => c.id)
  const byCode = async (code: string) => (await db.selectFrom('teaching_modes').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id
  modes = { online: await byCode('ONLINE'), home: await byCode('HOME_TUITION'), offline: await byCode('OFFLINE'), hybrid: await byCode('HYBRID'), batch: await byCode('BATCH') }
})

afterAll(async () => {
  await purgeUsersByPhone(phones)
  await deleteParent(parent)
  await pool.end()
})

describe('POST /registration/teacher', () => {
  it('creates the draft teacher, signs them in and points at the qualification step (T14.1)', async () => {
    const t = await register()
    const row = await db.selectFrom('teachers').selectAll().where('id', '=', t.teacherId).executeTakeFirstOrThrow()
    expect(row.verification_status).toBe('draft')
    expect(row.account_status).toBe('active')
    expect(row.public_code).toMatch(/^GC-T/)
    const user = await db.selectFrom('app_users').select(['user_type', 'phone']).where('id', '=', row.user_id).executeTakeFirstOrThrow()
    expect(user).toEqual({ user_type: 'teacher', phone: t.phone })
    const consents = await db.selectFrom('user_consents').select('consent_type').where('user_id', '=', row.user_id).execute()
    expect(consents.map((c) => c.consent_type).sort()).toEqual(['privacy_policy', 'terms'])
    const audit = await db.selectFrom('audit_logs').select('module').where('actor_id', '=', row.user_id).where('action', '=', 'app.teacher_registered').executeTakeFirst()
    expect(audit?.module).toBe('app.teacher_registration')

    const reg = await api(t).get('/teacher/registration')
    expect(reg.body.data.nextStep).toBe('qualification')
    expect(reg.body.data.completedSteps).toEqual(['personal'])
    const me = await api(t).get('/me')
    expect(me.body.data.registration).toEqual({ complete: false, nextStep: 'qualification' })
    expect(me.body.data.teacher).toEqual({ verificationStatus: 'draft' })
  })

  it('returns the same teacher and tokens for the same Idempotency-Key, even concurrently (T14.12)', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const { token } = registrationToken(phone)
    const key = randomUUID()
    const send = () => request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(regBody())
    const [a, b] = await Promise.all([send(), send()])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.body.data.teacherId).toBe(b.body.data.teacherId)
    const c = await send()
    expect(c.body.data).toEqual(a.body.data)
    expect(await db.selectFrom('teachers').select('id').where('phone', '=', phone).execute()).toHaveLength(1)
  })

  it('answers CONFLICT_STATE when the token was already used with another key', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const { token } = registrationToken(phone)
    const go = (key: string) => request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(regBody())
    expect((await go(randomUUID())).status).toBe(201)
    const second = await go(randomUUID())
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('CONFLICT_STATE')
  })

  it('limits attempts per registration token', async () => {
    const { token } = registrationToken(randomPhone())
    let last = 0
    for (let i = 0; i < 6; i++) {
      last = (await request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(regBody({ categoryId: randomUUID() }))).status
    }
    expect(last).toBe(429)
  })

  it('needs a registration token, an Idempotency-Key and a teacher-role token', async () => {
    expect((await request(app).post(`${APP}/registration/teacher`).set('Idempotency-Key', randomUUID()).send(regBody())).status).toBe(401)
    expect((await request(app).post(`${APP}/registration/teacher`).set('Authorization', 'Bearer nope').set('Idempotency-Key', randomUUID()).send(regBody())).status).toBe(401)
    const noKey = await request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${registrationToken(randomPhone()).token}`).send(regBody())
    expect(noKey.status).toBe(422)
    const parentToken = jwt.sign({ sub: randomPhone(), contactType: 'phone', role: 'parent', jti: randomUUID() }, env.APP_JWT_SECRET, { algorithm: 'HS256', audience: 'gc-register', expiresIn: 600 })
    const wrongRole = await request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${parentToken}`).set('Idempotency-Key', randomUUID()).send(regBody())
    expect(wrongRole.status).toBe(403)
    expect(wrongRole.body.error.code).toBe('FORBIDDEN')
  })

  it('validates the fields, including age 18-90 (T14.3)', async () => {
    const cases: Record<string, unknown>[] = [
      { dateOfBirth: dobFor(17) },
      { dateOfBirth: dobFor(95) },
      { dateOfBirth: 'yesterday' },
      { fullName: 'K' },
      { gender: 'robot' },
      { categoryId: 'nope' },
      { categoryId: randomUUID() },
    ]
    for (const over of cases) {
      const res = await request(app).post(`${APP}/registration/teacher`).set('Authorization', `Bearer ${registrationToken(randomPhone()).token}`).set('Idempotency-Key', randomUUID()).send(regBody(over))
      expect(res.status, JSON.stringify(over)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('records a valid teacher referral code (T14.11)', async () => {
    const owner = await createParent(m)
    const code = `TR${Date.now().toString().slice(-8)}`
    const rc = await db.insertInto('referral_codes').values({ user_id: owner.userId, code, program_code: 'TEACHER_REFERRAL' }).returning('id').executeTakeFirstOrThrow()
    const setting = await db.selectFrom('referral_settings').select('id').where('program_code', '=', 'TEACHER_REFERRAL').where('status', '=', 'active').executeTakeFirst()
    const t = await register({ referralCode: code })
    const ref = await db.selectFrom('referrals').select(['referral_code_id', 'status']).where('referee_user_id', '=', (await db.selectFrom('teachers').select('user_id').where('id', '=', t.teacherId).executeTakeFirstOrThrow()).user_id).executeTakeFirst()
    if (setting) expect(ref).toEqual({ referral_code_id: rc.id, status: 'pending' })
    else expect(ref).toBeUndefined()
    await purgeUsersByPhone([t.phone])
    await db.deleteFrom('referral_codes').where('id', '=', rc.id).execute()
    await deleteParent(owner)
  })
})

describe('GET /teacher/registration and progress', () => {
  it('is teacher-only', async () => {
    expect((await request(app).get(`${APP}/teacher/registration`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/registration`)).status).toBe(401)
  })

  it('resumes where the teacher stopped and reaches documents when all seven steps are done (T14.2, T14.1)', async () => {
    const t = await register()
    const c = api(t)
    expect((await c.post('/teacher/qualifications', qual())).status).toBe(201)
    let reg = (await c.get('/teacher/registration')).body.data
    expect(reg.completedSteps).toEqual(['personal', 'qualification'])
    expect(reg.nextStep).toBe('experience')
    expect(reg.qualifications).toHaveLength(1)

    expect((await c.patch('/teacher/registration/basics', { experienceYears: 4, highestQualification: 'M.Sc.' }, await version(t))).status).toBe(200)
    expect((await c.put('/teacher/subjects', { items: [{ subjectId: subjectIds[0], isPrimary: true }] })).status).toBe(200)
    expect((await c.put('/teacher/classes', { items: [{ classId: classIds[0] }] })).status).toBe(200)
    expect((await c.put('/teacher/teaching-modes', { items: [{ teachingModeId: modes.online }] })).status).toBe(200)
    reg = (await c.get('/teacher/registration')).body.data
    expect(reg.completedSteps).toEqual(['personal', 'qualification', 'experience', 'subjects', 'classes', 'teaching_modes', 'locations']) // online-only needs no location (T14.5)
    expect(reg.nextStep).toBe('documents')
    expect(reg.locations).toEqual([])
    expect((await c.get('/me')).body.data.registration).toEqual({ complete: false, nextStep: 'documents' })
  })
})

describe('PATCH /teacher/registration/basics', () => {
  it('updates personal and experience fields and recomputes completeness', async () => {
    const t = await register()
    const res = await api(t).patch(
      '/teacher/registration/basics',
      { email: 'Kavya@Example.com', languages: ['English', 'Hindi'], experienceYears: 4, highestQualification: 'B.Sc., B.Ed.', bio: 'b'.repeat(120), feePerHourPaise: 60000, demoAvailable: false },
      await version(t),
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ email: 'kavya@example.com', languages: ['English', 'Hindi'], experienceYears: 4, feePerHourPaise: 60000, demoAvailable: false })
    // bio>=100 (10) + experience (5) + fee (5) + languages (5)
    expect(res.body.data.profileCompleteness).toBe(25)
    const audit = await db.selectFrom('audit_logs').select('new_values').where('entity_id', '=', t.teacherId).where('action', '=', 'app.teacher_registration_step_saved').execute()
    expect(audit.map((a) => (a.new_values as { step: string }).step)).toEqual(['personal', 'experience'])
  })

  it('applies only the fields sent', async () => {
    const t = await register()
    const res = await api(t).patch('/teacher/registration/basics', { demoAvailable: false }, await version(t))
    expect(res.body.data).toMatchObject({ fullName: 'Kavya Menon', demoAvailable: false, experienceYears: null })
  })

  it('rejects a stale If-Match with VERSION_CONFLICT and a missing one with 422 (T14.9)', async () => {
    const t = await register()
    const v = await version(t)
    expect((await api(t).patch('/teacher/registration/basics', { bio: 'first' }, v)).status).toBe(200)
    const stale = await api(t).patch('/teacher/registration/basics', { bio: 'second' }, v)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
    expect((await api(t).patch('/teacher/registration/basics', { bio: 'x' })).status).toBe(422)
  })

  it('validates fields: bio contact info, fee, experience vs age, empty body', async () => {
    const t = await register({ dateOfBirth: dobFor(20) })
    const v = () => version(t)
    for (const body of [
      { bio: 'Call me on 9845012345' },
      { bio: 'mail me at a@b.com' },
      { bio: 'see https://example.com' },
      { bio: 'visit www.mysite.in' },
      { feePerHourPaise: 100_001 },
      { experienceYears: 5 }, // a 20-year-old has at most 4 working years
      { experienceYears: 61 },
      { email: 'not-an-email' },
      { languages: [] },
      { gender: 'x' },
      { categoryId: randomUUID() },
      {},
      { unknownField: 1 },
    ]) {
      const res = await api(t).patch('/teacher/registration/basics', body, await v())
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('is draft-only (T14.7)', async () => {
    const t = await register()
    for (const status of ['pending', 'under_review', 'reupload_requested', 'rejected']) {
      await setStatus(t.teacherId, status)
      const res = await api(t).patch('/teacher/registration/basics', { bio: 'hello' }, await version(t))
      expect(res.status, status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'verification_in_progress' } })
    }
    await setStatus(t.teacherId, 'approved')
    const approved = await api(t).patch('/teacher/registration/basics', { bio: 'hello' }, await version(t))
    expect(approved.status).toBe(409)
    expect(approved.body.error.details.reason).toBe('use_profile_editor')
  })
})

describe('qualifications', () => {
  it('adds, edits and soft-deletes; a new highest unsets the old one (T14.4)', async () => {
    const t = await register()
    const c = api(t)
    const first = await c.post('/teacher/qualifications', qual())
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ degree: 'M.Sc. Physics', isHighest: true, sortOrder: 1 })
    const second = await c.post('/teacher/qualifications', qual({ level: 'graduate', degree: 'B.Ed.', isHighest: true }))
    expect(second.body.data.sortOrder).toBe(2)
    let list = (await c.get('/teacher/registration')).body.data.qualifications
    expect(list.filter((q: { isHighest: boolean }) => q.isHighest)).toHaveLength(1)
    expect(list.find((q: { isHighest: boolean }) => q.isHighest).degree).toBe('B.Ed.')

    const patched = await c.patch(`/teacher/qualifications/${first.body.data.id}`, { grade: '80%', isHighest: true })
    expect(patched.status).toBe(200)
    expect(patched.body.data.grade).toBe('80%')
    list = (await c.get('/teacher/registration')).body.data.qualifications
    expect(list.find((q: { isHighest: boolean }) => q.isHighest).id).toBe(first.body.data.id)

    expect((await c.del(`/teacher/qualifications/${second.body.data.id}`)).status).toBe(200)
    expect((await c.get('/teacher/registration')).body.data.qualifications).toHaveLength(1)
    const row = await db.selectFrom('teacher_qualifications').select('deleted_at').where('id', '=', second.body.data.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    const events = await db.selectFrom('audit_logs').select('action').where('entity_id', '=', t.teacherId).where('action', 'like', 'app.teacher_qualification_%').execute()
    expect(events.map((e) => e.action).sort()).toEqual(['app.teacher_qualification_added', 'app.teacher_qualification_added', 'app.teacher_qualification_deleted', 'app.teacher_qualification_updated'])
  })

  it('lets the last qualification be deleted while drafting, which un-completes the step', async () => {
    const t = await register()
    const q = await api(t).post('/teacher/qualifications', qual())
    await api(t).del(`/teacher/qualifications/${q.body.data.id}`)
    expect((await api(t).get('/teacher/registration')).body.data.nextStep).toBe('qualification')
  })

  it("never touches another teacher's qualification", async () => {
    const a = await register()
    const b = await register()
    const q = await api(a).post('/teacher/qualifications', qual())
    expect((await api(b).patch(`/teacher/qualifications/${q.body.data.id}`, { degree: 'Hacked' })).status).toBe(404)
    expect((await api(b).del(`/teacher/qualifications/${q.body.data.id}`)).status).toBe(404)
    expect((await api(a).del(`/teacher/qualifications/${randomUUID()}`)).status).toBe(404)
  })

  it('validates fields and locks while under review', async () => {
    const t = await register()
    for (const over of [{ level: 'phd' }, { degree: 'x' }, { institution: '' }, { yearCompleted: 1959 }, { yearCompleted: new Date().getFullYear() + 1 }, { grade: 'g'.repeat(41) }]) {
      const res = await api(t).post('/teacher/qualifications', qual(over))
      expect(res.status, JSON.stringify(over)).toBe(422)
    }
    const q = await api(t).post('/teacher/qualifications', qual())
    await setStatus(t.teacherId, 'pending')
    const locked = await api(t).post('/teacher/qualifications', qual())
    expect(locked.status).toBe(409)
    expect(locked.body.error.details.reason).toBe('verification_in_progress')
    expect((await api(t).patch(`/teacher/qualifications/${q.body.data.id}`, { grade: 'A' })).status).toBe(409)
    expect((await api(t).del(`/teacher/qualifications/${q.body.data.id}`)).status).toBe(409)
    await setStatus(t.teacherId, 'approved')
    expect((await api(t).post('/teacher/qualifications', qual({ isHighest: false }))).status).toBe(201)
  })
})

describe('replace-set steps', () => {
  it('subjects: replaces the set, auto-promotes a primary and diffs (BR-14.6)', async () => {
    const t = await register()
    const c = api(t)
    const first = await c.put('/teacher/subjects', { items: [{ subjectId: subjectIds[0] }, { subjectId: subjectIds[1], experienceYears: 3 }] })
    expect(first.status).toBe(200)
    expect(first.body.data.items.filter((s: { isPrimary: boolean }) => s.isPrimary).map((s: { subjectId: string }) => s.subjectId)).toEqual([subjectIds[0]])

    const second = await c.put('/teacher/subjects', { items: [{ subjectId: subjectIds[1], isPrimary: true, experienceYears: 5 }, { subjectId: subjectIds[2] }] })
    expect(second.body.data.items).toHaveLength(2)
    expect(second.body.data.items[0]).toMatchObject({ subjectId: subjectIds[1], isPrimary: true, experienceYears: 5 })
    const audit = await db.selectFrom('audit_logs').select('new_values').where('entity_id', '=', t.teacherId).where('action', '=', 'app.teacher_subjects_set').orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ added: 1, removed: 1 })
  })

  it('subjects: rejects 11 subjects and leaves the existing 10 untouched (T14.10)', async () => {
    const t = await register()
    const c = api(t)
    expect((await c.put('/teacher/subjects', { items: subjectIds.slice(0, 10).map((id, i) => ({ subjectId: id, isPrimary: i === 0 })) })).status).toBe(200)
    const res = await c.put('/teacher/subjects', { items: subjectIds.slice(0, 11).map((id, i) => ({ subjectId: id, isPrimary: i === 0 })) })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(await db.selectFrom('teacher_subjects').select('id').where('teacher_id', '=', t.teacherId).execute()).toHaveLength(10)
  })

  it('subjects: rejects empty, duplicate, two-primary and unknown subjects', async () => {
    const t = await register()
    const c = api(t)
    for (const items of [[], [{ subjectId: subjectIds[0] }, { subjectId: subjectIds[0] }], [{ subjectId: subjectIds[0], isPrimary: true }, { subjectId: subjectIds[1], isPrimary: true }], [{ subjectId: randomUUID() }]]) {
      expect((await c.put('/teacher/subjects', { items })).status).toBe(422)
    }
  })

  it('classes: replaces the set with optional boards and enforces limits', async () => {
    const t = await register()
    const c = api(t)
    const res = await c.put('/teacher/classes', { items: [{ classId: classIds[0], boardId: m.boards.cbse }, { classId: classIds[1] }] })
    expect(res.status).toBe(200)
    expect(res.body.data.items).toHaveLength(2)
    expect((await c.put('/teacher/classes', { items: [{ classId: classIds[2] }] })).body.data.items).toHaveLength(1)
    expect((await c.put('/teacher/classes', { items: [] })).status).toBe(422)
    expect((await c.put('/teacher/classes', { items: classIds.slice(0, 16).concat(classIds.slice(0, 5)).map((classId) => ({ classId })) })).status).toBe(422) // >20
    expect((await c.put('/teacher/classes', { items: [{ classId: classIds[0] }, { classId: classIds[0] }] })).status).toBe(422)
    expect((await c.put('/teacher/classes', { items: [{ classId: randomUUID() }] })).status).toBe(422)
    expect((await c.put('/teacher/classes', { items: [{ classId: classIds[0], boardId: randomUUID() }] })).status).toBe(422)
  })

  it('teaching modes: replaces the set, accepts bare ids, rejects 0 or >4', async () => {
    const t = await register()
    const c = api(t)
    const res = await c.put('/teacher/teaching-modes', { items: [{ teachingModeId: modes.online }, modes.home] })
    expect(res.status).toBe(200)
    expect(res.body.data.items.map((i: { code: string }) => i.code).sort()).toEqual(['HOME_TUITION', 'ONLINE'])
    expect((await c.put('/teacher/teaching-modes', { items: [] })).status).toBe(422)
    expect((await c.put('/teacher/teaching-modes', { items: Object.values(modes).map((teachingModeId) => ({ teachingModeId })) })).status).toBe(422)
    expect((await c.put('/teacher/teaching-modes', { items: [modes.online, modes.online] })).status).toBe(422)
    expect((await c.put('/teacher/teaching-modes', { items: [randomUUID()] })).status).toBe(422)
  })

  it('locations: online-only teachers may skip, others must add one (T14.5, T14.6)', async () => {
    const t = await register()
    const c = api(t)
    const noModes = await c.put('/teacher/locations', { items: [] })
    expect(noModes.status).toBe(422)
    expect(noModes.body.error.details[0].reason).toBe('location_required')

    await c.put('/teacher/teaching-modes', { items: [modes.home] })
    const homeEmpty = await c.put('/teacher/locations', { items: [] })
    expect(homeEmpty.status).toBe(422)
    expect(homeEmpty.body.error.details[0].reason).toBe('location_required')

    await c.put('/teacher/teaching-modes', { items: [modes.online] })
    expect((await c.put('/teacher/locations', { items: [] })).status).toBe(200)
  })

  it('locations: validates primary, radius, uniqueness and area/city pairing', async () => {
    const t = await register()
    const c = api(t)
    await c.put('/teacher/teaching-modes', { items: [modes.home] })
    const loc = { cityId: m.city.id, areaId: m.areas[0]!.id, isPrimary: true, travelRadiusKm: 8, addressLine: '5th Block' }

    const ok = await c.put('/teacher/locations', { items: [loc] })
    expect(ok.status).toBe(200)
    expect(ok.body.data.items[0]).toMatchObject({ cityId: m.city.id, areaId: m.areas[0]!.id, isPrimary: true, travelRadiusKm: 8 })

    const bad: object[][] = [
      [{ ...loc, travelRadiusKm: undefined }], // required for home tuition
      [{ ...loc, travelRadiusKm: 1 }],
      [{ ...loc, travelRadiusKm: 26 }],
      [{ ...loc, isPrimary: false }], // exactly one primary
      [loc, { ...loc, areaId: m.areas[1]!.id }], // two primaries
      [loc, { ...loc, isPrimary: false }], // same city+area twice
      [{ ...loc, cityId: m.otherCity.id }], // area belongs to another city
      [{ ...loc, cityId: randomUUID() }],
      Array.from({ length: 6 }, (_, i) => ({ cityId: m.city.id, areaId: m.areas[i]?.id ?? null, isPrimary: i === 0, travelRadiusKm: 5 })),
    ]
    for (const items of bad) expect((await c.put('/teacher/locations', { items })).status, JSON.stringify(items)).toBe(422)
    expect((await c.get('/teacher/registration')).body.data.locations).toHaveLength(1)
  })

  it('locks every replace-set endpoint while under review but reopens them once approved (BR-14.8)', async () => {
    const t = await register()
    const c = api(t)
    const calls: [string, object][] = [
      ['/teacher/subjects', { items: [{ subjectId: subjectIds[0] }] }],
      ['/teacher/classes', { items: [{ classId: classIds[0] }] }],
      ['/teacher/teaching-modes', { items: [modes.online] }],
      ['/teacher/locations', { items: [] }],
    ]
    for (const status of ['pending', 'under_review', 'reupload_requested', 'rejected']) {
      await setStatus(t.teacherId, status)
      for (const [path, body] of calls) {
        const res = await c.put(path, body)
        expect(res.status, `${status} ${path}`).toBe(409)
        expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'verification_in_progress' } })
      }
    }
    await setStatus(t.teacherId, 'approved')
    for (const [path, body] of calls) expect((await c.put(path, body)).status, path).toBe(200)
  })

  it('throttles to 30 writes a minute per teacher', async () => {
    const t = await register()
    let last = 0
    for (let i = 0; i < 32; i++) last = (await api(t).put('/teacher/classes', { items: [{ classId: classIds[0] }] })).status
    expect(last).toBe(429)
  })

  it('is teacher-only', async () => {
    expect((await request(app).put(`${APP}/teacher/subjects`).set(bearer(parent)).send({ items: [] })).status).toBe(403)
    expect((await request(app).post(`${APP}/teacher/qualifications`).send(qual())).status).toBe(401)
  })
})

describe('profile completeness (BR-14.9)', () => {
  it('adds up the specified weights', async () => {
    const t = await register()
    const c = api(t)
    await c.post('/teacher/qualifications', qual()) // 10
    await c.put('/teacher/subjects', { items: [{ subjectId: subjectIds[0] }] }) // 15
    await c.put('/teacher/classes', { items: [{ classId: classIds[0] }] }) // 10
    await c.put('/teacher/teaching-modes', { items: [modes.online] }) // location-or-online 10
    const res = await c.patch('/teacher/registration/basics', { experienceYears: 3, highestQualification: 'M.Sc.', feePerHourPaise: 50000, languages: ['English'], bio: 'b'.repeat(100) }, await version(t)) // 5 + 5 + 5 + 10
    expect(res.body.data.profileCompleteness).toBe(70)
  })
})
