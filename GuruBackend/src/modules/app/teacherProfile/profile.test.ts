import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { APP, bearer, createParent, createTeacher, loadMasters, purgeUsersByPhone, uploadFile } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../../test/appHelpers.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent
let classIds: string[]

type Opts = Parameters<typeof createTeacher>[1]
async function newTeacher(over: Opts = {}): Promise<TestTeacher> {
  const t = await createTeacher(m, { status: 'approved', subjectIds: [m.subjects.physics, m.subjects.maths], ...over })
  phones.push(t.phone)
  await db.insertInto('teacher_teaching_modes').values({ teacher_id: t.teacherId, teaching_mode_id: m.modes.online }).execute()
  return t
}
const api = (t: { token: string }) => ({
  get: (p: string) => request(app).get(`${APP}${p}`).set(bearer(t)),
  post: (p: string, b: object) => request(app).post(`${APP}${p}`).set(bearer(t)).send(b),
  del: (p: string) => request(app).delete(`${APP}${p}`).set(bearer(t)),
  patch: (p: string, b: object, version?: string) => {
    const r = request(app).patch(`${APP}${p}`).set(bearer(t))
    return (version ? r.set('If-Match', version) : r).send(b)
  },
})
const version = async (t: { token: string }) => (await api(t).get('/teacher/profile')).body.data.teacher.updatedAt as string
const plan = (over: Record<string, unknown> = {}) => ({ label: 'JEE Physics batch', feeUnit: 'per_month', amountPaise: 400000, sessionsPerWeek: 3, ...over })
const setStatus = (id: string, status: string) => db.updateTable('teachers').set({ verification_status: status as 'pending' }).where('id', '=', id).execute()

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
  phones.push(parent.phone)
  classIds = (await db.selectFrom('classes').select('id').where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('level_order').execute()).map((c) => c.id)
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('GET /teacher/profile', () => {
  it('works in every verification status and reports the checklist (T17.2)', async () => {
    for (const status of ['draft', 'pending', 'reupload_requested', 'approved'] as const) {
      const t = await newTeacher({ status })
      const res = await api(t).get('/teacher/profile')
      expect(res.status, status).toBe(200)
      expect(res.body.data.teacher.verificationStatus).toBe(status)
      expect(res.body.data.completeness.items.map((i: { key: string }) => i.key)).toEqual(['photo', 'bio', 'qualification', 'experience', 'subjects', 'classes', 'locations', 'fee', 'languages', 'certificate'])
    }
  })

  it('returns teacher, subjects, classes and fee plans', async () => {
    const t = await newTeacher({ classIds: [classIds[10]!] })
    await api(t).post('/teacher/fee-plans', plan())
    const res = await api(t).get('/teacher/profile')
    expect(res.body.data.teacher).toMatchObject({ id: t.teacherId, fullName: 'Meera Nair', photoUrl: null, verificationStatus: 'approved', languages: [] })
    expect(res.body.data.subjects).toHaveLength(2)
    expect(res.body.data.subjects[0]).toMatchObject({ isPrimary: true })
    expect(res.body.data.classes).toEqual([{ classId: classIds[10], name: expect.any(String), boardName: null }])
    expect(res.body.data.feePlans).toEqual([expect.objectContaining({ label: 'JEE Physics batch', feeUnit: 'per_month', amountPaise: 400000, sessionsPerWeek: 3 })])
  })

  it('caps completeness at 85 without an approved certificate and reaches 100 with one (T17.5)', async () => {
    const t = await newTeacher({ classIds: [classIds[10]!] })
    const c = api(t)
    await db.insertInto('teacher_qualifications').values({ teacher_id: t.teacherId, level: 'graduate', degree: 'B.Sc.', institution: 'X' }).execute()
    const { fileId } = await uploadFile(app, t, { purpose: 'teacher_photo' })
    const patch = await c.patch('/teacher/profile', { bio: 'b'.repeat(120), languages: ['English'], experienceYears: 6, feePerHourPaise: 50000, profilePhotoFileId: fileId }, await version(t))
    expect(patch.status, JSON.stringify(patch.body)).toBe(200)
    expect(patch.body.data.completeness.percent).toBe(85)
    const missing = patch.body.data.completeness.items.filter((i: { earned: number }) => i.earned === 0)
    expect(missing).toEqual([{ key: 'certificate', label: 'An approved certificate', earned: 0, of: 15 }])
    expect(patch.body.data.teacher.photoUrl).toMatch(/\/cdn\//)

    // Admin M16 approves a certificate; the next write recomputes
    const file = await db.insertInto('files').values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.pdf`, original_name: 'c.pdf', mime_type: 'application/pdf', size_bytes: 5, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('teacher_documents').values({ teacher_id: t.teacherId, doc_type: 'education_certificate', file_id: file.id, status: 'approved' }).execute()
    const next = await c.patch('/teacher/profile', { demoAvailable: false }, await version(t))
    expect(next.body.data.completeness.percent).toBe(100)
  })

  it('counts a fee plan or an online-only teaching setup towards fee and locations', async () => {
    const t = await newTeacher()
    const before = (await api(t).get('/teacher/profile')).body.data.completeness.items as { key: string; earned: number }[]
    expect(before.find((i) => i.key === 'locations')!.earned).toBe(10) // createTeacher adds a location
    expect(before.find((i) => i.key === 'fee')!.earned).toBe(0)
    await api(t).post('/teacher/fee-plans', plan())
    expect(((await api(t).get('/teacher/profile')).body.data.completeness.items as { key: string; earned: number }[]).find((i) => i.key === 'fee')!.earned).toBe(5)

    const online = await newTeacher({ cityId: null })
    const items = (await api(online).get('/teacher/profile')).body.data.completeness.items as { key: string; earned: number }[]
    expect(items.find((i) => i.key === 'locations')!.earned).toBe(10) // online mode only, no location needed
  })

  it('is teacher-only', async () => {
    expect((await request(app).get(`${APP}/teacher/profile`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/profile`)).status).toBe(401)
  })
})

describe('PATCH /teacher/profile', () => {
  it('edits bio and languages and updates the completeness immediately (T17.1)', async () => {
    const t = await newTeacher()
    const before = (await api(t).get('/teacher/profile')).body.data.completeness.percent
    const res = await api(t).patch('/teacher/profile', { bio: 'I have taught JEE Physics for 14 years, focusing on problem-solving speed for the exam and concept clarity.', languages: ['English', 'Hindi', 'Kannada'] }, await version(t))
    expect(res.status).toBe(200)
    expect(res.body.data.teacher.languages).toEqual(['English', 'Hindi', 'Kannada'])
    expect(res.body.data.completeness.percent).toBe(before + 15) // bio 10 + languages 5
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_profile_updated').executeTakeFirstOrThrow()
    expect((audit.new_values as { changedFields: string[] }).changedFields.sort()).toEqual(['bio', 'languages'])
  })

  it('refuses every write until the teacher is approved (T17.2)', async () => {
    for (const status of ['draft', 'pending', 'under_review', 'reupload_requested', 'rejected'] as const) {
      const t = await newTeacher({ status })
      const res = await api(t).patch('/teacher/profile', { bio: 'hello' }, await version(t))
      expect(res.status, status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Complete verification before editing your public profile.', details: { reason: 'not_approved' } })
      expect((await api(t).post('/teacher/fee-plans', plan())).status).toBe(409)
    }
  })

  it('requires If-Match and rejects a stale one (T17.8)', async () => {
    const t = await newTeacher()
    const v = await version(t)
    expect((await api(t).patch('/teacher/profile', { bio: 'first' })).status).toBe(422)
    expect((await api(t).patch('/teacher/profile', { bio: 'first' }, v)).status).toBe(200)
    const stale = await api(t).patch('/teacher/profile', { bio: 'second' }, v)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
  })

  it('needs a reason to change fullName or dateOfBirth and leaves a trail (T17.3)', async () => {
    const t = await newTeacher({ fullName: 'Meera Nair' })
    const c = api(t)
    const noReason = await c.patch('/teacher/profile', { fullName: 'Meera N. Iyer' }, await version(t))
    expect(noReason.status).toBe(422)
    expect(noReason.body.error.details[0]).toMatchObject({ path: 'reason', message: "Tell us why you're changing this" })
    expect((await c.patch('/teacher/profile', { fullName: 'Meera N. Iyer', reason: 'too short' }, await version(t))).status).toBe(422)
    expect((await c.patch('/teacher/profile', { fullName: 'Meera N. Iyer', reason: 'x'.repeat(501) }, await version(t))).status).toBe(422)

    const ok = await c.patch('/teacher/profile', { fullName: 'Meera N. Iyer', dateOfBirth: '1990-05-04', reason: 'Married name change, matches my Aadhaar' }, await version(t))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.teacher).toMatchObject({ fullName: 'Meera N. Iyer', verificationStatus: 'approved' })
    const logs = await db.selectFrom('teacher_verification_logs').select(['action', 'is_internal', 'note', 'metadata']).where('teacher_id', '=', t.teacherId).orderBy('created_at').execute()
    expect(logs).toHaveLength(2)
    expect(logs.every((l) => l.action === 'note_added' && l.is_internal && l.note === 'Married name change, matches my Aadhaar')).toBe(true)
    const meta = logs.map((l) => l.metadata as { profile_changed_after_approval: boolean; field: string; oldValue: string | null; newValue: string })
    expect(meta.find((x) => x.field === 'fullName')).toEqual({ profile_changed_after_approval: true, field: 'fullName', oldValue: 'Meera Nair', newValue: 'Meera N. Iyer' })
    expect(meta.find((x) => x.field === 'dateOfBirth')).toMatchObject({ newValue: '1990-05-04' })
    const events = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_identity_field_changed').execute()
    expect(events.map((e) => (e.new_values as { field: string }).field).sort()).toEqual(['dateOfBirth', 'fullName'])
    expect((await db.selectFrom('app_users').select('full_name').where('id', '=', t.userId).executeTakeFirstOrThrow()).full_name).toBe('Meera N. Iyer')
    // the internal rows never reach the teacher's own timeline (Module 16)
    expect((await request(app).get(`${APP}/teacher/verification`).set(bearer(t))).body.data.timeline).toEqual([])
  })

  it('needs no reason when an identity field is sent unchanged', async () => {
    const t = await newTeacher({ fullName: 'Meera Nair' })
    const res = await api(t).patch('/teacher/profile', { fullName: 'Meera Nair', bio: 'About me' }, await version(t))
    expect(res.status).toBe(200)
    expect(await db.selectFrom('teacher_verification_logs').select('id').where('teacher_id', '=', t.teacherId).execute()).toHaveLength(0)
  })

  it('validates fields, including contact details in the bio', async () => {
    const t = await newTeacher()
    for (const body of [
      { bio: 'Call 9845012345' },
      { bio: 'mail a@b.com' },
      { bio: 'see www.site.in' },
      { bio: 'x'.repeat(2001) },
      { email: 'nope' },
      { languages: [] },
      { feePerHourPaise: 100_001 },
      { experienceYears: 61 },
      { gender: 'x' },
      { categoryId: randomUUID() },
      { dateOfBirth: '2015-01-01', reason: 'because I need to fix it' },
      {},
      { somethingElse: 1 },
    ]) {
      const res = await api(t).patch('/teacher/profile', body, await version(t))
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('only accepts an active teacher_photo file owned by the caller (BR-17.2)', async () => {
    const t = await newTeacher()
    const other = await newTeacher()
    const c = api(t)
    const mine = (await uploadFile(app, t, { purpose: 'teacher_photo' })).fileId
    const theirs = (await uploadFile(app, other, { purpose: 'teacher_photo' })).fileId
    const avatar = (await uploadFile(app, t, { purpose: 'avatar' })).fileId
    const document = (await uploadFile(app, t, { purpose: 'teacher_document' })).fileId
    const pending = (await request(app).post(`${APP}/uploads/presign`).set(bearer(t)).send({ purpose: 'teacher_photo', mimeType: 'image/jpeg', sizeBytes: 100, fileName: 'a.jpg' })).body.data.fileId

    for (const id of [theirs, avatar, document, pending, randomUUID(), 'nope']) {
      const res = await c.patch('/teacher/profile', { profilePhotoFileId: id }, await version(t))
      expect(res.status, id).toBe(422)
    }
    const ok = await c.patch('/teacher/profile', { profilePhotoFileId: mine }, await version(t))
    expect(ok.status).toBe(200)
    expect(ok.body.data.teacher.photoUrl).toContain('/cdn/teacher-photos/')
  })

  it('is teacher-only', async () => {
    expect((await request(app).patch(`${APP}/teacher/profile`).set(bearer(parent)).set('If-Match', new Date().toISOString()).send({ bio: 'x' })).status).toBe(403)
  })
})

describe('fee plans', () => {
  it('adds, edits and soft-deletes plans in order (BR-17.3)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const a = await c.post('/teacher/fee-plans', plan({ subjectId: m.subjects.physics, classFromId: classIds[10], classToId: classIds[11], teachingModeId: m.modes.online, notes: 'Group batch of up to 8 students' }))
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    expect(a.body.data).toMatchObject({ label: 'JEE Physics batch', feeUnit: 'per_month', amountPaise: 400000, sessionsPerWeek: 3, sortOrder: 1, notes: 'Group batch of up to 8 students' })
    const b = await c.post('/teacher/fee-plans', plan({ label: 'Hourly', feeUnit: 'per_hour', amountPaise: 120000, sessionsPerWeek: undefined, sessionMinutes: 60 }))
    expect(b.body.data).toMatchObject({ sortOrder: 2, feeUnit: 'per_hour', sessionMinutes: 60 })

    const edited = await c.patch(`/teacher/fee-plans/${a.body.data.id}`, { amountPaise: 450000, label: 'JEE Physics batch (new)' })
    expect(edited.status).toBe(200)
    expect(edited.body.data).toMatchObject({ amountPaise: 450000, label: 'JEE Physics batch (new)', sessionsPerWeek: 3, subjectId: m.subjects.physics })

    expect((await c.del(`/teacher/fee-plans/${a.body.data.id}`)).status).toBe(200)
    expect((await c.get('/teacher/fee-plans')).body.data.map((p: { id: string }) => p.id)).toEqual([b.body.data.id])
    const row = await db.selectFrom('teacher_fee_plans').select('deleted_at').where('id', '=', a.body.data.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull() // soft delete (T17.10)

    const events = await db.selectFrom('audit_logs').select(['action', 'new_values']).where('actor_id', '=', t.userId).where('action', 'like', 'app.teacher_fee_plan_%').orderBy('created_at').execute()
    expect(events.map((e) => e.action)).toEqual(['app.teacher_fee_plan_added', 'app.teacher_fee_plan_added', 'app.teacher_fee_plan_updated', 'app.teacher_fee_plan_deleted'])
    expect(events[0]!.new_values).toMatchObject({ label: 'JEE Physics batch', amountPaise: 400000 })
  })

  it('validates the unit rules, class range, ownership of subject and mode, and amounts (BR-17.4)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const chemistryNotMine = m.subjects.chemistry
    const homeNotMine = m.modes.home
    for (const body of [
      plan({ label: 'x' }),
      plan({ label: 'y'.repeat(61) }),
      plan({ feeUnit: 'per_year' }),
      plan({ feeUnit: 'per_hour', sessionMinutes: undefined, sessionsPerWeek: undefined }),
      plan({ feeUnit: 'per_hour', sessionMinutes: 29 }),
      plan({ feeUnit: 'per_hour', sessionMinutes: 181 }),
      plan({ sessionsPerWeek: undefined }), // per_month needs it
      plan({ feeUnit: 'per_course', sessionsPerWeek: undefined }),
      plan({ sessionsPerWeek: 0 }),
      plan({ sessionsPerWeek: 15 }),
      plan({ amountPaise: 4999 }),
      plan({ amountPaise: 10_000_001 }),
      plan({ amountPaise: 1.5 }),
      plan({ notes: 'n'.repeat(201) }),
      plan({ classFromId: classIds[11], classToId: classIds[3] }), // from > to
      plan({ subjectId: chemistryNotMine }),
      plan({ teachingModeId: homeNotMine }),
      plan({ subjectId: randomUUID() }),
      plan({ unknown: 1 }),
    ]) {
      const res = await c.post('/teacher/fee-plans', body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    const subjectErr = await c.post('/teacher/fee-plans', plan({ subjectId: chemistryNotMine }))
    expect(subjectErr.body.error.details[0].message).toBe('Add this subject to your profile first')
    expect((await c.get('/teacher/fee-plans')).body.data).toEqual([])
    // once the subject is on the profile it is accepted (T17.4)
    await db.insertInto('teacher_subjects').values({ teacher_id: t.teacherId, subject_id: chemistryNotMine }).execute()
    expect((await c.post('/teacher/fee-plans', plan({ subjectId: chemistryNotMine }))).status).toBe(201)
  })

  it('validates the merged plan on edit', async () => {
    const t = await newTeacher()
    const created = await api(t).post('/teacher/fee-plans', plan())
    const id = created.body.data.id
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, { feeUnit: 'per_hour' })).status).toBe(422) // no session length
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, { feeUnit: 'per_hour', sessionMinutes: 45 })).status).toBe(200)
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, {})).status).toBe(422)
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, { amountPaise: 1 })).status).toBe(422)
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, { subjectId: m.subjects.biology })).status).toBe(422)
    expect((await api(t).patch(`/teacher/fee-plans/${id}`, { subjectId: null })).status).toBe(200)
  })

  it('allows 12 plans and rejects the 13th until one is deleted (T17.6)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const ids: string[] = []
    for (let i = 1; i <= 12; i++) ids.push((await c.post('/teacher/fee-plans', plan({ label: `Plan ${i}` }))).body.data.id)
    const thirteenth = await c.post('/teacher/fee-plans', plan({ label: 'Plan 13' }))
    expect(thirteenth.status).toBe(422)
    expect(thirteenth.body.error.details[0].reason).toBe('max_fee_plans')
    expect((await c.del(`/teacher/fee-plans/${ids[0]}`)).status).toBe(200)
    const again = await c.post('/teacher/fee-plans', plan({ label: 'Plan 13' }))
    expect(again.status).toBe(201)
    expect(again.body.data.sortOrder).toBe(13)
  })

  it("404s for someone else's, deleted or malformed plan ids", async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    const created = await api(a).post('/teacher/fee-plans', plan())
    const id = created.body.data.id
    expect((await api(b).patch(`/teacher/fee-plans/${id}`, { label: 'Hacked' })).status).toBe(404)
    expect((await api(b).del(`/teacher/fee-plans/${id}`)).status).toBe(404)
    await api(a).del(`/teacher/fee-plans/${id}`)
    expect((await api(a).patch(`/teacher/fee-plans/${id}`, { label: 'Again' })).status).toBe(404)
    expect((await api(a).del(`/teacher/fee-plans/${id}`)).status).toBe(404)
    expect((await api(a).del('/teacher/fee-plans/nope')).status).toBe(422)
  })

  it('lists plans in every status but writes only when approved', async () => {
    const t = await newTeacher()
    await api(t).post('/teacher/fee-plans', plan())
    await setStatus(t.teacherId, 'pending')
    expect((await api(t).get('/teacher/fee-plans')).body.data).toHaveLength(1)
    const planId = (await api(t).get('/teacher/fee-plans')).body.data[0].id
    expect((await api(t).patch(`/teacher/fee-plans/${planId}`, { label: 'Nope' })).status).toBe(409)
    expect((await api(t).del(`/teacher/fee-plans/${planId}`)).status).toBe(409)
  })

  it('is teacher-only', async () => {
    expect((await request(app).post(`${APP}/teacher/fee-plans`).set(bearer(parent)).send(plan())).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/fee-plans`)).status).toBe(401)
  })
})

describe('GET /teacher/profile/preview (BR-17.6)', () => {
  it('flags an unapproved profile as not visible to parents (T17.7)', async () => {
    const t = await newTeacher({ status: 'pending' })
    const res = await api(t).get('/teacher/profile/preview')
    expect(res.status).toBe(200)
    expect(res.body.data.visibleToParents).toBe(false)
    expect(res.body.data.teacher.fullName).toBe('Meera Nair')
  })

  it('shows an approved profile as parents see it, without private details', async () => {
    const t = await newTeacher({ trust: 88.2 })
    await api(t).post('/teacher/fee-plans', plan())
    await db.insertInto('teacher_availability').values([{ teacher_id: t.teacherId, day_of_week: 1, start_time: '18:00', end_time: '21:00' }, { teacher_id: t.teacherId, day_of_week: 7, start_time: '10:00', end_time: '12:00', accepts_demos: false }]).execute()
    await db.updateTable('teacher_locations').set({ address_line: '5th Block, secret street' }).where('teacher_id', '=', t.teacherId).execute()
    await db.updateTable('teachers').set({ date_of_birth: '1990-01-01', email: 'private@example.com', is_verified_badge: true, rating_avg: '4.7', rating_count: 41 }).where('id', '=', t.teacherId).execute()

    const res = await api(t).get('/teacher/profile/preview')
    expect(res.body.data).toMatchObject({
      visibleToParents: true,
      trustScore: 88.2,
      rating: { avg: 4.7, count: 41 },
      availability: { weeklySlots: 2, demoDays: [1] },
    })
    expect(res.body.data.teacher).toMatchObject({ publicCode: expect.stringMatching(/^GC-T/), isVerifiedBadge: true, categoryName: 'Home Tutor' })
    expect(res.body.data.feePlans).toHaveLength(1)
    expect(res.body.data.locations[0]).toMatchObject({ cityName: expect.any(String), isPrimary: true })
    const text = JSON.stringify(res.body)
    for (const secret of [t.phone, 'private@example.com', '1990-01-01', 'secret street']) expect(text).not.toContain(secret)
  })

  it('is teacher-only', async () => {
    expect((await request(app).get(`${APP}/teacher/profile/preview`).set(bearer(parent))).status).toBe(403)
  })
})
