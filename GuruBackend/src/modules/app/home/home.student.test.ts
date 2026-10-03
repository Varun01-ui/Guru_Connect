import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { kvSet } from '../../../lib/kv.js'
import { APP, bearer, createParent, createTeacher, deleteParent, loadMasters, purgeUsersByPhone, randomPhone, registrationToken } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../../test/appHelpers.js'
import { coldStartKey } from '../student/student.service.js'

const app = createApp()
let m: Masters
let parent: TestParent
const phones: string[] = []
const teachers: TestTeacher[] = []

async function newStudent(over: Record<string, unknown> = {}) {
  const phone = randomPhone()
  phones.push(phone)
  const res = await request(app)
    .post(`${APP}/registration/student`)
    .set('Authorization', `Bearer ${registrationToken(phone).token}`)
    .send({ fullName: 'Aarav Kumar', classId: m.classes.eleven, cityId: m.city.id, subjectIds: [], consents: { terms: true, privacyPolicy: true }, ...over })
  expect(res.status).toBe(201)
  const user = await db.selectFrom('app_users').select('id').where('phone', '=', phone).executeTakeFirstOrThrow()
  return { token: res.body.data.accessToken as string, userId: user.id, studentId: res.body.data.studentId as string }
}

const home = (s: { token: string }, query = '') => request(app).get(`${APP}/home/student${query}`).set(bearer(s))

async function newTeacher(over: Parameters<typeof createTeacher>[1] = {}) {
  const t = await createTeacher(m, over)
  phones.push(t.phone)
  teachers.push(t)
  return t
}

const ids = (res: request.Response, rail = 'recommended_teachers') => res.body.data.rails[rail].items.map((i: { teacherId: string }) => i.teacherId) as string[]
// The combined response shows 10 per rail; ranking assertions page the rail with the maximum limit instead.
const rankedIds = async (s: { token: string }) => ((await home(s, '?rail=recommended_teachers&limit=20')).body.data.items as { teacherId: string }[]).map((i) => i.teacherId)

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
})

afterAll(async () => {
  await purgeUsersByPhone(phones)
  await deleteParent(parent)
  await pool.end()
})

describe('GET /home/student', () => {
  it('returns banners and all five rails, with the consent status (T12.1, T12.4)', async () => {
    const s = await newStudent()
    const res = await home(s)
    expect(res.status).toBe(200)
    expect(res.body.data.parentalConsent).toBe('not_required')
    expect(Object.keys(res.body.data.rails).sort()).toEqual(['nearby_teachers', 'recommended_institutes', 'recommended_teachers', 'top_rated_teachers', 'verified_teachers'])
    expect(res.body.data.banners).toEqual({ home_top: [], home_middle: [] })
    expect(res.body.data.rails.recommended_teachers.header).toBe('Popular near you')
    expect(res.body.data.rails.recommended_teachers.cachedAt).toBeTruthy()
  })

  it('falls back to the city\'s verified / top rated teachers when there is no signal (T12.10)', async () => {
    const s = await newStudent()
    const plain = await newTeacher({ trust: 40 })
    const strong = await newTeacher({ trust: 90, verified: true })
    const elsewhere = await newTeacher({ trust: 99, cityId: m.otherCity.id })
    const list = ids(await home(s))
    expect(list).toContain(strong.teacherId)
    expect(list).not.toContain(elsewhere.teacherId)
    expect(list.indexOf(strong.teacherId)).toBeLessThan(list.indexOf(plain.teacherId))
  })

  it('biases toward cold-start subjects before any search (T12.2)', async () => {
    const s = await newStudent({ subjectIds: [m.subjects.physics] })
    const physics = await newTeacher({ trust: 50, subjectIds: [m.subjects.physics] })
    const other = await newTeacher({ trust: 80, subjectIds: [m.subjects.hindi] })
    const res = await home(s)
    expect(res.body.data.rails.recommended_teachers.header).toBe('Recommended for you')
    const list = ids(res)
    expect(list.indexOf(physics.teacherId)).toBeLessThan(list.indexOf(other.teacherId))
  })

  it('shifts toward searched subjects (T12.3)', async () => {
    const s = await newStudent()
    await kvSet(coldStartKey(s.userId), '[]', 60)
    const chem = await newTeacher({ trust: 10, subjectIds: [m.subjects.chemistry] })
    const bio = await newTeacher({ trust: 60, subjectIds: [m.subjects.biology] })
    for (let i = 0; i < 3; i++) await db.insertInto('user_search_history').values({ user_id: s.userId, target: 'teacher', query_text: 'Chemistry', filters: JSON.stringify({ subjectIds: [m.subjects.chemistry] }) as never }).execute()
    const list = ids(await home(s))
    expect(list.indexOf(chem.teacherId)).toBeLessThan(list.indexOf(bio.teacherId))
  })

  it('weights class match and favourite category', async () => {
    const s = await newStudent({ classId: m.classes.eleven, subjectIds: [m.subjects.maths] })
    const classMatch = await newTeacher({ trust: 10, classIds: [m.classes.eleven] })
    const none = await newTeacher({ trust: 10 })
    const ranked = await rankedIds(s)
    expect(ranked.indexOf(classMatch.teacherId)).toBeLessThan(ranked.indexOf(none.teacherId))

    const coach = await newTeacher({ trust: 10, categoryId: m.categories.coaching })
    const tutor = await newTeacher({ trust: 10, categoryId: m.categories.language })
    const favSource = await newTeacher({ trust: 10, categoryId: m.categories.coaching })
    await db.insertInto('user_favorites').values({ user_id: s.userId, target_type: 'teacher', teacher_id: favSource.teacherId }).execute()
    const list = await rankedIds(s)
    expect(list.indexOf(coach.teacherId)).toBeLessThan(list.indexOf(tutor.teacherId))
  })

  it('excludes unapproved, suspended, dismissed and blocked teachers (T12.6)', async () => {
    const s = await newStudent({ subjectIds: [m.subjects.maths] })
    const ok = await newTeacher({ subjectIds: [m.subjects.maths] })
    const draft = await newTeacher({ status: 'draft', subjectIds: [m.subjects.maths] })
    const suspended = await newTeacher({ account: 'suspended', subjectIds: [m.subjects.maths] })
    const dismissed = await newTeacher({ subjectIds: [m.subjects.maths] })
    const blocked = await newTeacher({ subjectIds: [m.subjects.maths] })
    const blockedMe = await newTeacher({ subjectIds: [m.subjects.maths] })
    await db.insertInto('recommendation_dismissals').values({ user_id: s.userId, teacher_id: dismissed.teacherId }).execute()
    await db.insertInto('user_blocks').values({ blocker_user_id: s.userId, blocked_user_id: blocked.userId }).execute()
    await db.insertInto('user_blocks').values({ blocker_user_id: blockedMe.userId, blocked_user_id: s.userId }).execute()
    const list = ids(await home(s))
    expect(list).toContain(ok.teacherId)
    for (const t of [draft, suspended, dismissed, blocked, blockedMe]) expect(list).not.toContain(t.teacherId)
  })

  it('pages one rail with a cursor (T12.7)', async () => {
    const s = await newStudent({ subjectIds: [m.subjects.maths] })
    for (let i = 0; i < 3; i++) await newTeacher({ subjectIds: [m.subjects.maths] })
    const first = await home(s, '?rail=recommended_teachers&limit=2')
    expect(first.body.data.items).toHaveLength(2)
    expect(first.body.meta.nextCursor).toBeTruthy()
    const second = await home(s, `?rail=recommended_teachers&limit=2&cursor=${first.body.meta.nextCursor}`)
    const a = first.body.data.items.map((i: { teacherId: string }) => i.teacherId)
    const b = second.body.data.items.map((i: { teacherId: string }) => i.teacherId)
    expect(b.length).toBeGreaterThan(0)
    expect(a.filter((x: string) => b.includes(x))).toEqual([])
  })

  it('serves banners for audience all/students only', async () => {
    const s = await newStudent()
    const file = await db
      .insertInto('files')
      .values({ bucket: 'gc-public', object_key: `banners/stu-${Date.now()}.webp`, original_name: 'b.webp', mime_type: 'image/webp', size_bytes: 10, visibility: 'public', purpose: 'banner_image', uploaded_by_type: 'system', status: 'uploaded' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const mk = (title: string, audience: 'students' | 'parents') =>
      db.insertInto('banners').values({ title, image_file_id: file.id, placement: 'home_top', audience, starts_at: new Date(Date.now() - 1000), status: 'active' }).returning('id').executeTakeFirstOrThrow()
    const forStudents = await mk('For students', 'students')
    const forParents = await mk('For parents', 'parents')
    try {
      const titles = (await home(s)).body.data.banners.home_top.map((b: { title: string }) => b.title)
      expect(titles).toContain('For students')
      expect(titles).not.toContain('For parents')
    } finally {
      await db.deleteFrom('banners').where('id', 'in', [forStudents.id, forParents.id]).execute()
      await db.deleteFrom('files').where('id', '=', file.id).execute()
    }
  })

  it('rejects an unknown rail, other roles and missing auth', async () => {
    const s = await newStudent()
    const bad = await home(s, '?rail=nope')
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('VALIDATION_FAILED')
    expect((await request(app).get(`${APP}/home/student`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/home/student`)).status).toBe(401)
  })
})
