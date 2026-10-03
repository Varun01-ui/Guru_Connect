import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { APP, bearer, createParent, createTeacher, loadMasters, purgeUsersByPhone } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../../test/appHelpers.js'
import { istToday } from '../teacherAvailability/availability.service.js'
import { topSuggestion, trustBand } from './dashboard.service.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent
let requester: TestParent

const DAY = 86_400_000
const HOUR = 3_600_000
const plusDays = (n: number) => new Date(Date.parse(`${istToday()}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

async function newTeacher(over: Parameters<typeof createTeacher>[1] = {}): Promise<TestTeacher> {
  const t = await createTeacher(m, { status: 'approved', ...over })
  phones.push(t.phone)
  return t
}
const dash = (t: { token: string }, q = '') => request(app).get(`${APP}/teacher/dashboard${q}`).set(bearer(t))

const stat = (teacherId: string, offsetDays: number, over: Partial<{ profile_views: number; unique_viewers: number; lead_requests: number; demo_requests: number; demos_completed: number; reviews_published: number; rating_sum: number }> = {}) =>
  db.insertInto('teacher_daily_stats').values({ teacher_id: teacherId, stat_date: plusDays(offsetDays), ...over }).execute()

async function addLead(teacherId: string, over: { status?: string; createdAgoMs?: number; respondedAfterMs?: number | null; updatedAgoMs?: number } = {}) {
  const created = new Date(Date.now() - (over.createdAgoMs ?? HOUR))
  return db
    .insertInto('leads')
    .values({
      lead_type: 'inquiry',
      target_type: 'teacher',
      teacher_id: teacherId,
      requester_user_id: requester.userId,
      requester_type: 'parent',
      status: over.status ?? 'new',
      created_at: created,
      ...(over.respondedAfterMs != null ? { first_response_at: new Date(created.getTime() + over.respondedAfterMs) } : {}),
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
}

async function addDemo(teacherId: string, over: { status: 'requested' | 'confirmed' | 'completed' | 'no_show' | 'cancelled' | 'reschedule_proposed'; startOffsetMs: number }) {
  const lead = await addLead(teacherId, { status: 'contacted', createdAgoMs: 40 * HOUR })
  const start = new Date(Date.now() + over.startOffsetMs)
  return db
    .insertInto('demo_requests')
    .values({ lead_id: lead.id, teacher_id: teacherId, requester_user_id: requester.userId, requested_start_at: start, confirmed_start_at: start, status: over.status, ...(over.status === 'completed' ? { completed_at: start } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow()
}

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

describe('trust bands (T18.5)', () => {
  it.each([
    [100, 'excellent'],
    [90, 'excellent'],
    [89.99, 'good'],
    [80, 'good'],
    [79.99, 'fair'],
    [60, 'fair'],
    [59.99, 'poor'],
    [0, 'poor'],
  ])('%s is %s', (score, band) => expect(trustBand(score)).toBe(band))
})

describe('topSuggestion (BR-18.4)', () => {
  const weights = { pan: 10, aadhaar: 20, reviews: 25, complaints: 15, certificates: 20, profile_completeness: 10 }
  const full = { aadhaar_score: 100, pan_score: 100, certificate_score: 100, review_score: 100, complaint_score: 100, completeness_score: 100 }
  it('picks the factor with the largest weighted gap', () => {
    expect(topSuggestion({ ...full, certificate_score: 0, completeness_score: 50 }, weights)).toBe('Add a certificate to improve your score') // 2000 vs 500
    expect(topSuggestion({ ...full, certificate_score: 60, review_score: 0 }, weights)).toBe('Ask your students for reviews to improve your score') // 800 vs 2500
    expect(topSuggestion({ ...full, pan_score: 0, completeness_score: 0 }, weights)).toBe('Get your PAN verified to improve your score') // 1000 vs 1000: first listed wins? aadhaar not gapped
  })
  it('has nothing to suggest when every factor is full', () => {
    expect(topSuggestion(full, weights)).toBeNull()
  })
})

describe('GET /teacher/dashboard', () => {
  it('hides metrics for teachers who are not approved yet (T18.2)', async () => {
    for (const status of ['draft', 'pending', 'under_review', 'rejected'] as const) {
      const t = await newTeacher({ status })
      const res = await dash(t)
      expect(res.status, status).toBe(200)
      expect(res.body.data).toEqual({ verificationStatus: status, range: 7, kpis: null, trustScore: null, profileCompleteness: null, unansweredLeads: 0, recentActivity: [] })
    }
  })

  it('tells a re-upload teacher how many documents need attention (T18.3)', async () => {
    const t = await newTeacher({ status: 'reupload_requested' })
    const file = await db.insertInto('files').values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.jpg`, original_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 5, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()
    for (const docType of ['pan', 'photo'] as const) {
      const f = await db.insertInto('files').values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.jpg`, original_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 5, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()
      await db.insertInto('teacher_documents').values({ teacher_id: t.teacherId, doc_type: docType, file_id: f.id, status: 'reupload_requested' }).execute()
    }
    await db.insertInto('teacher_documents').values({ teacher_id: t.teacherId, doc_type: 'aadhaar', file_id: file.id, status: 'approved' }).execute()
    const res = await dash(t)
    expect(res.body.data).toMatchObject({ verificationStatus: 'reupload_requested', kpis: null, documentsNeedingAttention: 2 })
  })

  it('validates the range and defaults to 7 (BR-18.1)', async () => {
    const t = await newTeacher()
    expect((await dash(t)).body.data.range).toBe(7)
    expect((await dash(t, '?range=30')).body.data.range).toBe(30)
    for (const q of ['?range=14', '?range=0', '?range=abc', '?range=']) {
      const res = await dash(t, q)
      expect(res.status, q).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('sums the roll-up over the range with deltas against the previous period (T18.1)', async () => {
    const t = await newTeacher()
    await stat(t.teacherId, 0, { profile_views: 100, unique_viewers: 80, lead_requests: 10, demo_requests: 5, demos_completed: 2, reviews_published: 2, rating_sum: 9 })
    await stat(t.teacherId, -6, { profile_views: 20, unique_viewers: 10, lead_requests: 2, demo_requests: 1, demos_completed: 2, reviews_published: 1, rating_sum: 5 }) // oldest day of the range
    await stat(t.teacherId, -7, { profile_views: 60, unique_viewers: 50, lead_requests: 6, demo_requests: 4, demos_completed: 1, reviews_published: 0 }) // first day of the previous period
    await stat(t.teacherId, -13, { profile_views: 60, unique_viewers: 50, lead_requests: 6, demo_requests: 4, demos_completed: 1 })
    await stat(t.teacherId, -14, { profile_views: 9999 }) // outside both
    await stat(t.teacherId, 1, { profile_views: 9999 }) // tomorrow is not in range

    const res = await dash(t)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.period).toEqual({ from: plusDays(-6), to: plusDays(0) })
    expect(d.previousPeriod).toEqual({ from: plusDays(-13), to: plusDays(-7) })
    expect(d.kpis.profileViews).toEqual({ value: 120, previous: 120, deltaPct: 0 })
    expect(d.kpis.uniqueViewers).toMatchObject({ value: 90, previous: 100, deltaPct: -10 })
    expect(d.kpis.leadRequests).toMatchObject({ value: 12, previous: 12, deltaPct: 0 })
    expect(d.kpis.demoRequests).toMatchObject({ value: 6, previous: 8, deltaPct: -25 })
    expect(d.kpis.demosCompleted).toMatchObject({ value: 4, previous: 2, deltaPct: 100 })
    expect(d.kpis.reviewsPublished).toMatchObject({ value: 3, previous: 0, deltaPct: null }) // nothing to compare against
    expect(d.kpis.avgRating).toEqual({ value: 4.67, previous: null }) // (9+5)/3

    const thirty = (await dash(t, '?range=30')).body.data
    expect(thirty.kpis.profileViews.value).toBe(100 + 20 + 60 + 60 + 9999) // day -14 is inside a 30-day window
  })

  it('shows null, not 0, for the average rating with no reviews (T18.8)', async () => {
    const t = await newTeacher()
    const d = (await dash(t)).body.data
    expect(d.kpis.avgRating.value).toBeNull()
    expect(d.kpis.profileViews).toEqual({ value: 0, previous: 0, deltaPct: null })
  })

  it('counts live leads and demos (BR-18.2)', async () => {
    const t = await newTeacher()
    await addLead(t.teacherId, { status: 'new', createdAgoMs: 30 * HOUR }) // unanswered
    await addLead(t.teacherId, { status: 'viewed', createdAgoMs: 25 * HOUR }) // unanswered
    await addLead(t.teacherId, { status: 'new', createdAgoMs: 2 * HOUR }) // open, not yet overdue
    await addLead(t.teacherId, { status: 'contacted', createdAgoMs: 50 * HOUR, respondedAfterMs: HOUR }) // open
    await addLead(t.teacherId, { status: 'closed', createdAgoMs: 50 * HOUR })
    await addLead(t.teacherId, { status: 'spam', createdAgoMs: 50 * HOUR })
    await addDemo(t.teacherId, { status: 'confirmed', startOffsetMs: 2 * HOUR })
    await addDemo(t.teacherId, { status: 'requested', startOffsetMs: DAY })
    await addDemo(t.teacherId, { status: 'reschedule_proposed', startOffsetMs: DAY })
    await addDemo(t.teacherId, { status: 'confirmed', startOffsetMs: -2 * HOUR }) // already started
    await addDemo(t.teacherId, { status: 'cancelled', startOffsetMs: DAY })
    const d = (await dash(t)).body.data
    expect(d.unansweredLeads).toBe(2)
    expect(d.openLeads).toBe(9) // 4 open leads + the 5 'contacted' leads that back the demos
    expect(d.upcomingDemos).toBe(3)
  })

  it('computes the response rate and median first response over the range (BR-18.3)', async () => {
    const t = await newTeacher()
    await addLead(t.teacherId, { createdAgoMs: 2 * DAY, respondedAfterMs: 10 * 60_000, status: 'contacted' })
    await addLead(t.teacherId, { createdAgoMs: 2 * DAY, respondedAfterMs: 120 * 60_000, status: 'contacted' })
    await addLead(t.teacherId, { createdAgoMs: 2 * DAY, respondedAfterMs: 30 * HOUR, status: 'contacted' }) // too slow for the rate
    await addLead(t.teacherId, { createdAgoMs: 2 * DAY, status: 'new' }) // never answered
    await addLead(t.teacherId, { createdAgoMs: 2 * DAY, status: 'spam', respondedAfterMs: 1 }) // spam never counts
    await addLead(t.teacherId, { createdAgoMs: 20 * DAY, respondedAfterMs: 1, status: 'contacted' }) // outside a 7-day range
    const d = (await dash(t)).body.data
    expect(d.responseRatePct).toBe(50)
    expect(d.medianFirstResponseMinutes).toBe(120)
    const wide = (await dash(t, '?range=30')).body.data
    expect(wide.responseRatePct).toBe(60) // 3 fast of 5 non-spam
  })

  it('has no response figures without leads', async () => {
    const t = await newTeacher()
    const d = (await dash(t)).body.data
    expect(d.responseRatePct).toBeNull()
    expect(d.medianFirstResponseMinutes).toBeNull()
  })

  it('reports the trust score, its band and the best suggestion (BR-18.4)', async () => {
    const t = await newTeacher({ trust: 94.1 })
    await db.updateTable('trust_scores').set({ aadhaar_score: 100, pan_score: 100, certificate_score: 0, review_score: 100, complaint_score: 100, completeness_score: 100 }).where('teacher_id', '=', t.teacherId).execute()
    const d = (await dash(t)).body.data
    expect(d.trustScore).toEqual({ score: 94.1, band: 'excellent', suggestion: 'Add a certificate to improve your score' })

    await db.updateTable('trust_scores').set({ score: '89.99' }).where('teacher_id', '=', t.teacherId).execute()
    expect((await dash(t)).body.data.trustScore.band).toBe('good')
    const none = await newTeacher()
    expect((await dash(none)).body.data.trustScore).toBeNull() // not scored yet
  })

  it('nudges towards the highest-point missing item, not the first one (T18.6)', async () => {
    const t = await newTeacher({ subjectIds: [m.subjects.maths], classIds: [(await db.selectFrom('classes').select('id').where('code', '=', 'CLASS_9').executeTakeFirstOrThrow()).id] })
    await db.insertInto('teacher_teaching_modes').values({ teacher_id: t.teacherId, teaching_mode_id: m.modes.online }).execute()
    await db.insertInto('teacher_qualifications').values({ teacher_id: t.teacherId, level: 'graduate', degree: 'B.Sc.', institution: 'X' }).execute()
    const photo = await db.insertInto('files').values({ bucket: 'gc-public', object_key: `test/${randomUUID()}.jpg`, original_name: 'p.jpg', mime_type: 'image/jpeg', size_bytes: 5, visibility: 'public', purpose: 'teacher_photo', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()
    await db.updateTable('teachers').set({ profile_photo_file_id: photo.id, bio: 'b'.repeat(120), experience_years: 5, fee_per_hour_paise: 50000 }).where('id', '=', t.teacherId).execute()
    // only languages (5) and the certificate (15) are missing
    const d = (await dash(t)).body.data
    expect(d.profileCompleteness).toEqual({ percent: 80, nextItem: { key: 'certificate', label: 'Get a certificate approved', points: 15 } })

    await db.updateTable('teachers').set({ languages: ['English'] as never }).where('id', '=', t.teacherId).execute()
    const file = await db.insertInto('files').values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.pdf`, original_name: 'c.pdf', mime_type: 'application/pdf', size_bytes: 5, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('teacher_documents').values({ teacher_id: t.teacherId, doc_type: 'education_certificate', file_id: file.id, status: 'approved' }).execute()
    // completeness is recomputed on the next profile write; the dashboard reads the live checklist
    const full = (await dash(t)).body.data
    expect(full.profileCompleteness).toEqual({ percent: 100, nextItem: null })
  })

  it('lists the five most recent events with first name + last initial only (BR-18.6, T18.10)', async () => {
    const t = await newTeacher()
    const lead = await addLead(t.teacherId, { status: 'converted', createdAgoMs: 3 * HOUR })
    await db.updateTable('leads').set({ contact_unlocked: true }).where('id', '=', lead.id).execute()
    const reviewer = await createParent(m, { fullName: 'Rahul Menon' })
    phones.push(reviewer.phone)
    const review = await db.insertInto('teacher_reviews').values({ teacher_id: t.teacherId, author_user_id: reviewer.userId, author_type: 'parent', rating: 5, comment: 'c'.repeat(40), status: 'published', published_at: new Date(Date.now() - 2 * HOUR) }).returning('id').executeTakeFirstOrThrow()
    const completed = await addDemo(t.teacherId, { status: 'completed', startOffsetMs: -HOUR })
    const noShow = await addDemo(t.teacherId, { status: 'no_show', startOffsetMs: -30 * 60_000 })
    for (let i = 0; i < 4; i++) await addLead(t.teacherId, { status: 'viewed', createdAgoMs: (10 + i) * HOUR })

    const d = (await dash(t)).body.data
    expect(d.recentActivity).toHaveLength(5)
    const times = d.recentActivity.map((e: { at: string }) => e.at)
    expect([...times].sort().reverse()).toEqual(times)
    const types = d.recentActivity.map((e: { type: string }) => e.type)
    expect(types).toContain('review_published')
    expect(types).toContain('demo_completed')
    const review5 = d.recentActivity.find((e: { type: string }) => e.type === 'review_published')
    expect(review5).toMatchObject({ label: 'New 5★ review from a parent', deepLink: `gc://teacher/reviews/${review.id}` })
    expect(d.recentActivity.find((e: { type: string }) => e.type === 'demo_completed')).toMatchObject({ label: 'Demo with Lakshmi V. completed', deepLink: `gc://demos/${completed.id}` })
    expect(d.recentActivity.some((e: { deepLink: string }) => e.deepLink === `gc://demos/${noShow.id}`)).toBe(true)
    const text = JSON.stringify(d)
    for (const secret of [requester.phone, requester.email, 'Venkatesh', reviewer.phone, 'Menon']) expect(text).not.toContain(secret)
    expect(text).toContain('Lakshmi V.')
  })

  it('is scoped to the caller and teacher-only', async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    await stat(a.teacherId, 0, { profile_views: 77 })
    await addLead(a.teacherId, { status: 'new', createdAgoMs: 48 * HOUR })
    expect((await dash(b)).body.data.kpis.profileViews.value).toBe(0)
    expect((await dash(b)).body.data.unansweredLeads).toBe(0)
    expect((await request(app).get(`${APP}/teacher/dashboard`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/dashboard`)).status).toBe(401)
  })
})
