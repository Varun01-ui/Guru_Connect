import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db, pool } from '../../db/index.js'
import { outbox } from '../../lib/mailer.js'
import { smsOutbox } from '../../lib/providers/sms.js'
import { APP, bearer, createTeacher, loadMasters, purgeUsersByPhone } from '../../test/appHelpers.js'
import type { Masters, TestTeacher } from '../../test/appHelpers.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { faceMatchResult, nameMatchResult, nameSimilarity } from './tv.checks.js'
import { releaseStaleClaims, runPendingChecks, sendSlaAlerts } from './tv.jobs.js'
import { slaOf } from './tv.queries.js'

const app = createApp()
const phones: string[] = []
const HOUR = 3_600_000
let m: Masters
let superAdmin: TestAdmin
let verifier: TestAdmin // verification_admin: review + decide + unmask
let reviewer: TestAdmin // review only (a junior)
let roleIds: Record<string, string>

const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const post = (a: { token: string }, path: string, body: object = {}) => request(app).post(`${API}${path}`).set(authed(a.token)).send(body)

// ---- fixtures -----------------------------------------------------------------

type DocSpec = { type: string; status?: string; title?: string; hash?: string; version?: number; current?: boolean; note?: string; mime?: string }
const FULL_SET: DocSpec[] = [{ type: 'aadhaar' }, { type: 'pan' }, { type: 'education_certificate', title: 'B.Ed. 2019' }, { type: 'photo' }]

async function seedCase(
  over: { status?: 'pending' | 'under_review' | 'reupload_requested' | 'approved' | 'rejected' | 'draft'; docs?: DocSpec[]; claimedBy?: string | null; submittedAgoHours?: number; cityId?: string | null; categoryId?: string; subjects?: string[]; fullName?: string; createdBy?: string | null; txn?: 'captured' | 'created' | null } = {},
): Promise<TestTeacher & { docIds: Record<string, string> }> {
  const t = await createTeacher(m, { status: over.status ?? 'under_review', subjectIds: over.subjects ?? [m.subjects.physics], cityId: over.cityId, categoryId: over.categoryId, fullName: over.fullName ?? 'Karan Chatterjee' })
  phones.push(t.phone)
  const set: Record<string, unknown> = { submitted_at: new Date(Date.now() - (over.submittedAgoHours ?? 2) * HOUR), reviewed_by: over.claimedBy ?? null, created_by: over.createdBy ?? null, date_of_birth: '1995-02-11' }
  if (over.txn) {
    const txn = await db
      .insertInto('transactions')
      .values({ user_id: t.userId, payer_type: 'teacher', purpose: 'teacher_registration', fee_code: 'TEACHER_REGISTRATION', amount_paise: 49900, base_amount_paise: 42288, gst_paise: 7612, status: over.txn })
      .returning('id')
      .executeTakeFirstOrThrow()
    set.registration_transaction_id = txn.id
  }
  await db.updateTable('teachers').set(set as never).where('id', '=', t.teacherId).execute()
  const docIds: Record<string, string> = {}
  for (const d of over.docs ?? FULL_SET) {
    const file = await db
      .insertInto('files')
      .values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.${d.mime === 'application/pdf' ? 'pdf' : 'jpg'}`, original_name: 'doc', mime_type: d.mime ?? 'image/jpeg', size_bytes: 10, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: t.userId, status: 'uploaded' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const row = await db
      .insertInto('teacher_documents')
      .values({ teacher_id: t.teacherId, doc_type: d.type as 'aadhaar', file_id: file.id, title: d.title ?? null, doc_number_masked: d.type === 'aadhaar' ? 'XXXX XXXX 2978' : null, doc_number_hash: d.hash ?? null, version: d.version ?? 1, is_current: d.current ?? true, status: (d.status ?? 'submitted') as 'submitted', review_note: d.note ?? null })
      .returning('id')
      .executeTakeFirstOrThrow()
    if ((d.current ?? true) && !docIds[d.type]) docIds[d.type] = row.id
  }
  return Object.assign(t, { docIds })
}
const allApproved: DocSpec[] = FULL_SET.map((d) => ({ ...d, status: 'approved' }))
const state = (teacherId: string) => db.selectFrom('teachers').selectAll().where('id', '=', teacherId).executeTakeFirstOrThrow()
const logs = (teacherId: string, action?: string) => {
  let q = db.selectFrom('teacher_verification_logs').selectAll().where('teacher_id', '=', teacherId).orderBy('created_at')
  if (action) q = q.where('action', '=', action)
  return q.execute()
}
const auditOf = (entityId: string, action: string) => db.selectFrom('audit_logs').select(['new_values', 'reason', 'actor_id']).where('entity_id', '=', entityId).where('action', '=', action).execute()

beforeAll(async () => {
  m = await loadMasters()
  roleIds = Object.fromEntries((await db.selectFrom('roles').select(['id', 'code']).where('deleted_at', 'is', null).execute()).map((r) => [r.code, r.id]))
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], fullName: 'TV Super' })
  verifier = await createAdminWithToken({ roles: ['verification_admin'], fullName: 'Anjali Menon' })
  reviewer = await createAdminWithToken({ fullName: 'Junior Reviewer' })
  const role = await db.insertInto('roles').values({ code: `rbac_test_reviewer_${Date.now()}`, name: `RBAC Test Reviewer ${Date.now()}`, is_system: false }).returning('id').executeTakeFirstOrThrow()
  await db.insertInto('role_permissions').columns(['role_id', 'permission_id']).expression((eb) => eb.selectFrom('permissions').select([eb.val(role.id).as('role_id'), 'id']).where('key', 'in', ['teachers.read', 'teacher_verification.review'])).execute()
  await db.insertInto('admin_roles').values({ admin_id: reviewer.id, role_id: role.id }).execute()
})
afterEach(() => {
  outbox.length = 0
  smsOutbox.length = 0
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await purgeRbacFixtures()
  await pool.end()
})

describe('helpers', () => {
  it('colours the SLA by age (FR-16.1)', () => {
    expect([0, 11, 12, 24, 25, 100].map(slaOf)).toEqual(['green', 'green', 'amber', 'amber', 'red', 'red'])
  })
  it('scores names and maps scores to results (FR-16.4)', () => {
    expect(nameSimilarity('Karan Chatterjee', 'CHATTERJEE KARAN')).toBe(1)
    expect(nameSimilarity('Karan Chatterjee', 'Karan Kumar Chatterjee')).toBeGreaterThanOrEqual(0.8)
    expect(nameSimilarity('Karan Chatterjee', 'Priya Nair')).toBe(0)
    expect([0.95, 0.85, 0.7, 0.6, 0.59].map(nameMatchResult)).toEqual(['pass', 'pass', 'warn', 'warn', 'fail'])
    expect([0.95, 0.9, 0.8, 0.75, 0.7].map(faceMatchResult)).toEqual(['pass', 'pass', 'warn', 'warn', 'fail'])
  })
})

describe('GET /teacher-verifications (queue)', () => {
  it('lists pending and under-review cases oldest first with SLA, documents and payment (FR-16.1)', async () => {
    const old = await seedCase({ status: 'under_review', submittedAgoHours: 30, claimedBy: verifier.id, docs: [{ type: 'aadhaar', status: 'approved' }, { type: 'pan' }], txn: 'captured', fullName: 'Queue Oldest' })
    const mid = await seedCase({ status: 'pending', submittedAgoHours: 15, fullName: 'Queue Middle' })
    const fresh = await seedCase({ status: 'pending', submittedAgoHours: 1, fullName: 'Queue Fresh' })
    const out = await seedCase({ status: 'reupload_requested', submittedAgoHours: 40, fullName: 'Queue Reupload' })
    const res = await get(verifier, '/teacher-verifications?pageSize=100&q=Queue')
    expect(res.status).toBe(200)
    const rows = res.body.data as { teacherId: string }[]
    expect(rows.map((r) => r.teacherId)).toEqual([old.teacherId, mid.teacherId, fresh.teacherId]) // reupload_requested is not in the default tabs
    expect(res.body.data[0]).toMatchObject({
      publicCode: expect.stringMatching(/^GC-T/),
      fullName: 'Queue Oldest',
      primarySubject: 'Physics',
      city: m.city.name,
      status: 'under_review',
      sla: 'red',
      assignedTo: { id: verifier.id, name: 'Anjali Menon' },
      documents: { approved: 1, total: 2 },
      payment: 'paid',
    })
    expect(res.body.data[0].ageHours).toBeGreaterThanOrEqual(30)
    expect([res.body.data[1].sla, res.body.data[2].sla]).toEqual(['amber', 'green'])
    expect(res.body.data[1]).toMatchObject({ assignedTo: null, payment: 'not_required', checks: { nameMatch: null, duplicate: null, faceMatch: null } })
    expect(res.body.meta).toEqual({ page: 1, pageSize: 100, total: 3, totalPages: 1 })
    const reupload = await get(verifier, '/teacher-verifications?status=reupload_requested&q=Queue')
    expect(reupload.body.data.map((r: { teacherId: string }) => r.teacherId)).toEqual([out.teacherId])
  })

  it('filters by SLA, assignee, category, city, payment, checks and dates', async () => {
    const me = await seedCase({ status: 'under_review', claimedBy: verifier.id, submittedAgoHours: 5, fullName: 'Filter Mine', categoryId: m.categories.coaching })
    const other = await seedCase({ status: 'under_review', claimedBy: superAdmin.id, submittedAgoHours: 30, fullName: 'Filter Theirs', cityId: m.otherCity.id, txn: 'created' })
    const free = await seedCase({ status: 'pending', submittedAgoHours: 14, fullName: 'Filter Free' })
    const ids = async (q: string) => ((await get(verifier, `/teacher-verifications?pageSize=100&q=Filter&${q}`)).body.data as { teacherId: string }[]).map((r) => r.teacherId).sort()
    const sorted = (...t: TestTeacher[]) => t.map((x) => x.teacherId).sort()
    expect(await ids('sla=green')).toEqual(sorted(me))
    expect(await ids('sla=amber')).toEqual(sorted(free))
    expect(await ids('sla=red')).toEqual(sorted(other))
    expect(await ids('assigned=me')).toEqual(sorted(me))
    expect(await ids('assigned=unassigned')).toEqual(sorted(free))
    expect(await ids('assigned=anyone')).toEqual(sorted(me, other, free))
    expect(await ids(`categoryId=${m.categories.coaching}`)).toEqual(sorted(me))
    expect(await ids(`cityId=${m.otherCity.id}`)).toEqual(sorted(other))
    expect(await ids('payment=unpaid')).toEqual(sorted(other))
    expect(await ids('payment=not_required')).toEqual(sorted(me, free))
    const day = (offset: number) => new Date(Date.now() + 5.5 * HOUR + offset * 24 * HOUR).toISOString().slice(0, 10) // IST calendar date
    expect(await ids(`submittedFrom=${day(-3)}&submittedTo=${day(0)}`)).toEqual(sorted(me, other, free)) // all three were submitted within the last two days
    expect(await ids(`submittedFrom=${day(1)}&submittedTo=${day(2)}`)).toEqual([])
    expect(await ids('submittedFrom=2000-01-01&submittedTo=2000-01-02')).toEqual([])

    await db.insertInto('teacher_verification_logs').values({ teacher_id: other.teacherId, action: 'auto_check', is_internal: true, metadata: JSON.stringify({ type: 'duplicate_identity', result: 'fail' }) as never }).execute()
    expect(await ids('hasFailedCheck=true')).toEqual(sorted(other))
    expect(await ids('hasFailedCheck=false')).toEqual(sorted(me, free))
    const row = (await get(verifier, '/teacher-verifications?q=Filter Theirs')).body.data[0]
    expect(row.checks.duplicate).toBe('fail')
    // a later pass replaces the earlier failure
    await db.insertInto('teacher_verification_logs').values({ teacher_id: other.teacherId, action: 'auto_check', is_internal: true, metadata: JSON.stringify({ type: 'duplicate_identity', result: 'pass' }) as never, created_at: new Date(Date.now() + 1000) }).execute()
    expect(await ids('hasFailedCheck=true')).toEqual([])
  })

  it('searches by name, public code, email prefix, and phone only with users.pii (FR-17)', async () => {
    const t = await seedCase({ status: 'pending', fullName: 'Searchable Zephyr' })
    const code = (await state(t.teacherId)).public_code
    const ids = async (admin: TestAdmin, q: string) => ((await get(admin, `/teacher-verifications?q=${encodeURIComponent(q)}`)).body.data as { teacherId: string }[]).map((r) => r.teacherId)
    expect(await ids(verifier, 'Searchable Zephyr')).toContain(t.teacherId)
    expect(await ids(verifier, 'zephyr')).toContain(t.teacherId)
    expect(await ids(verifier, code)).toEqual([t.teacherId])
    expect(await ids(verifier, code.toLowerCase())).toEqual([t.teacherId])
    expect(await ids(superAdmin, t.phone.slice(-10))).toContain(t.teacherId)
    expect(await ids(verifier, t.phone.slice(-10))).not.toContain(t.teacherId) // no users.pii: phone is not searchable
  })

  it('paginates, sorts and validates the query', async () => {
    for (let i = 0; i < 3; i++) await seedCase({ status: 'pending', fullName: `Pager ${i}`, submittedAgoHours: 3 + i })
    const p1 = await get(verifier, '/teacher-verifications?q=Pager&pageSize=10&page=1&sort=fullName:desc')
    expect(p1.body.data.map((r: { fullName: string }) => r.fullName)).toEqual(['Pager 2', 'Pager 1', 'Pager 0'])
    expect(p1.body.meta).toMatchObject({ total: 3, totalPages: 1 })
    for (const q of ['?pageSize=7', '?page=0', '?sort=password:asc', '?status=draft', '?sla=blue', '?assigned=bob', '?cityId=x', '?payment=maybe', '?q=a', '?submittedFrom=yesterday']) {
      expect((await get(verifier, `/teacher-verifications${q}`)).status, q).toBe(422)
    }
  })

  it('requires teachers.read', async () => {
    const nobody = await createAdminWithToken()
    expect((await get(nobody, '/teacher-verifications')).status).toBe(403)
    expect((await request(app).get(`${API}/teacher-verifications`)).status).toBe(401)
  })
})

describe('GET /teacher-verifications/stats', () => {
  it('counts the queue, the oldest case and decisions this week', async () => {
    const before = (await get(verifier, '/teacher-verifications/stats')).body.data
    await seedCase({ status: 'pending', submittedAgoHours: 50 })
    await seedCase({ status: 'under_review', submittedAgoHours: 3, claimedBy: verifier.id })
    await seedCase({ status: 'reupload_requested' })
    const after = (await get(verifier, '/teacher-verifications/stats')).body.data
    expect(after.pending - before.pending).toBe(1)
    expect(after.underReview - before.underReview).toBe(1)
    expect(after.reuploadRequested - before.reuploadRequested).toBe(1)
    expect(after.inQueue - before.inQueue).toBe(2)
    expect(after.overSla - before.overSla).toBe(1)
    expect(after.oldestAgeHours).toBeGreaterThanOrEqual(50)
    expect(after.decisionsThisWeek).toEqual({ approved: expect.any(Number), rejected: expect.any(Number) })
  })
})

describe('GET /teacher-verifications/:teacherId (case)', () => {
  it('shows application data, documents with versions, checks, timeline, payment and duplicates (FR-16.3)', async () => {
    const other = await seedCase({ status: 'under_review', docs: [{ type: 'aadhaar', hash: 'h-dup-1' }] })
    const t = await seedCase({
      status: 'under_review',
      claimedBy: verifier.id,
      txn: 'captured',
      docs: [
        { type: 'aadhaar', status: 'approved', hash: 'h-dup-1' },
        { type: 'education_certificate', title: 'B.Ed. 2019', version: 1, current: false, status: 'reupload_requested', note: 'Cropped' },
        { type: 'education_certificate', title: 'B.Ed. 2019', version: 2 },
        { type: 'professional_certificate', title: 'Cert', mime: 'application/pdf' },
      ],
    })
    await db.insertInto('teacher_verification_logs').values([{ teacher_id: t.teacherId, action: 'submitted', is_internal: false, created_at: new Date(Date.now() - 3 * HOUR) }, { teacher_id: t.teacherId, action: 'assigned', admin_id: verifier.id, is_internal: true, created_at: new Date(Date.now() - 2 * HOUR) }, { teacher_id: t.teacherId, action: 'auto_check', is_internal: true, metadata: JSON.stringify({ type: 'face_match', result: 'warn', score: 0.62 }) as never }]).execute()

    const res = await get(verifier, `/teacher-verifications/${t.teacherId}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.teacher).toMatchObject({ id: t.teacherId, fullName: 'Karan Chatterjee', gender: null, dateOfBirth: '1995-02-11', category: 'Home Tutor', subjects: ['Physics'], city: m.city.name, status: 'under_review', assignedTo: { id: verifier.id, name: 'Anjali Menon' } })
    expect(d.teacher.phoneMasked).toMatch(/XXXXX$/)
    expect(d.teacher).not.toHaveProperty('phone') // verifier lacks users.pii
    const cert = d.documents.find((x: { docType: string }) => x.docType === 'education_certificate')
    expect(cert).toMatchObject({ version: 2, status: 'submitted', title: 'B.Ed. 2019', previousVersions: [{ version: 1, status: 'reupload_requested', reviewNote: 'Cropped' }] })
    expect(cert.thumbnailUrl).toMatch(/^http.*expires=/)
    expect(d.documents.find((x: { docType: string }) => x.docType === 'aadhaar')).toMatchObject({ numberMasked: 'XXXX XXXX 2978', status: 'approved' })
    expect(d.documents.find((x: { docType: string }) => x.docType === 'professional_certificate').thumbnailUrl).toBeNull() // PDFs have no thumbnail
    expect(d.checks).toEqual([{ type: 'face_match', result: 'warn', score: 0.62, detail: null }])
    expect(d.timeline.map((e: { action: string }) => e.action)).toEqual(['submitted', 'assigned'])
    expect(d.timeline[1]).toMatchObject({ by: 'Anjali Menon', isInternal: true })
    expect(d.payment).toMatchObject({ transactionCode: expect.stringMatching(/^TXN-/), amountPaise: 49900, status: 'captured' })
    expect(d.duplicates).toEqual([{ teacherId: other.teacherId, publicCode: expect.any(String), docType: 'aadhaar' }])

    const pii = await get(superAdmin, `/teacher-verifications/${t.teacherId}`)
    expect(pii.body.data.teacher.phone).toBe(t.phone)
  })

  it('pages the timeline with a cursor (latest 50 first)', async () => {
    const t = await seedCase({ status: 'under_review' })
    await db.insertInto('teacher_verification_logs').values(Array.from({ length: 55 }, (_, i) => ({ teacher_id: t.teacherId, action: 'note_added', note: `note ${i}`, is_internal: true, created_at: new Date(Date.now() - (60 - i) * 60_000) }))).execute()
    const first = (await get(verifier, `/teacher-verifications/${t.teacherId}`)).body.data
    expect(first.timeline).toHaveLength(50)
    expect(first.timeline[49].note).toBe('note 54')
    expect(first.timelineNextCursor).toBeTruthy()
    const older = (await get(verifier, `/teacher-verifications/${t.teacherId}?cursor=${first.timelineNextCursor}`)).body.data
    expect(older.timeline).toHaveLength(5)
    expect(older.timeline[0].note).toBe('note 0')
    expect(older.timelineNextCursor).toBeNull()
  })

  it('404s for drafts, missing and malformed ids', async () => {
    const draft = await seedCase({ status: 'draft' })
    expect((await get(verifier, `/teacher-verifications/${draft.teacherId}`)).status).toBe(404)
    expect((await get(verifier, `/teacher-verifications/${randomUUID()}`)).status).toBe(404)
    expect((await get(verifier, '/teacher-verifications/nope')).status).toBe(404)
  })
})

describe('claim and release (FR-16.2)', () => {
  it('claims a pending case, moving it to under review', async () => {
    const t = await seedCase({ status: 'pending' })
    const res = await post(reviewer, `/teacher-verifications/${t.teacherId}/claim`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.teacher).toMatchObject({ status: 'under_review', assignedTo: { id: reviewer.id } })
    const row = await state(t.teacherId)
    expect([row.verification_status, row.reviewed_by]).toEqual(['under_review', reviewer.id])
    expect((await logs(t.teacherId, 'assigned'))).toHaveLength(1)
    expect((await auditOf(t.teacherId, 'teacher_verification.claimed'))[0]!.actor_id).toBe(reviewer.id)
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/claim`)).status).toBe(200) // claiming your own case again is a no-op
    expect(await logs(t.teacherId, 'assigned')).toHaveLength(1)
  })

  it('refuses a case someone else is reviewing, and only a decider may take over', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    const denied = await post(reviewer, `/teacher-verifications/${t.teacherId}/claim`)
    expect(denied.status).toBe(409)
    expect(denied.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Anjali is reviewing this case. Take over?', details: { claimedBy: { id: verifier.id, name: 'Anjali' } } })
    const juniorForce = await post(reviewer, `/teacher-verifications/${t.teacherId}/claim?force=true`)
    expect(juniorForce.status).toBe(403)
    const forced = await post(superAdmin, `/teacher-verifications/${t.teacherId}/claim?force=true`)
    expect(forced.status).toBe(200)
    expect((await state(t.teacherId)).reviewed_by).toBe(superAdmin.id)
    expect(await auditOf(t.teacherId, 'teacher_verification.taken_over')).toHaveLength(1)
  })

  it('only works on cases that are waiting or being reviewed', async () => {
    for (const status of ['reupload_requested', 'approved', 'rejected'] as const) {
      const t = await seedCase({ status })
      const res = await post(verifier, `/teacher-verifications/${t.teacherId}/claim`)
      expect(res.status, status).toBe(409)
      expect(res.body.error.message).toBe(`This teacher is ${status.replace('_', ' ')}.`)
    }
    expect((await post(verifier, `/teacher-verifications/${randomUUID()}/claim`)).status).toBe(404)
  })

  it('releases a claim back to the queue; only the reviewer or a decider may', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/release`)).status).toBe(403)
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/release`)).status).toBe(200)
    const row = await state(t.teacherId)
    expect([row.verification_status, row.reviewed_by]).toEqual(['pending', null])
    expect(await auditOf(t.teacherId, 'teacher_verification.released')).toHaveLength(1)
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/release`)).status).toBe(409) // nothing to release
  })

  it('needs teacher_verification.review', async () => {
    const t = await seedCase({ status: 'pending' })
    const readOnly = await createAdminWithToken({ roles: ['support_admin'] })
    expect((await post(readOnly, `/teacher-verifications/${t.teacherId}/claim`)).status).toBe(403)
  })
})

describe('document decisions (FR-16.5)', () => {
  it('approves a current document with a timeline entry the teacher can see', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id })
    const res = await post(reviewer, `/teacher-documents/${t.docIds.pan}/approve`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ docType: 'pan', status: 'approved' })
    const doc = await db.selectFrom('teacher_documents').select(['status', 'reviewed_by', 'reviewed_at', 'review_note']).where('id', '=', t.docIds.pan!).executeTakeFirstOrThrow()
    expect(doc).toMatchObject({ status: 'approved', reviewed_by: reviewer.id, review_note: null })
    expect(doc.reviewed_at).not.toBeNull()
    expect((await logs(t.teacherId, 'document_approved'))[0]).toMatchObject({ document_id: t.docIds.pan, is_internal: false, admin_id: reviewer.id })
    expect((await auditOf(t.docIds.pan!, 'teacher_document.approved'))[0]!.new_values).toMatchObject({ docType: 'pan' })
    expect((await db.selectFrom('user_notifications').select(['title', 'body', 'category']).where('user_id', '=', t.userId).executeTakeFirstOrThrow())).toEqual({ title: 'Document approved', body: 'Your PAN has been approved.', category: 'verification' })

    // and the teacher's own app shows it in the timeline (mobile M16)
    const mobile = await request(app).get(`${APP}/teacher/verification`).set(bearer(t))
    expect(mobile.body.data.timeline.map((e: { label: string }) => e.label)).toContain('PAN approved')
    expect(mobile.body.data.documents.find((d: { docType: string }) => d.docType === 'pan').status).toBe('approved')
  })

  it('rejects and requests re-upload with a reason code and a note; the teacher is told once, later (FR-16.5)', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id })
    const rej = await post(reviewer, `/teacher-documents/${t.docIds.pan}/reject`, { reasonCode: 'NAME_MISMATCH', note: "The name on the PAN doesn't match your Aadhaar." })
    expect(rej.status).toBe(200)
    const re = await post(reviewer, `/teacher-documents/${t.docIds.education_certificate}/request-reupload`, { reasonCode: 'CROPPED', note: 'The certificate image is cropped; the seal is not visible.' })
    expect(re.status).toBe(200)
    const docs = await db.selectFrom('teacher_documents').select(['doc_type', 'status', 'review_note']).where('teacher_id', '=', t.teacherId).where('status', '<>', 'submitted').orderBy('doc_type').execute()
    expect(docs).toEqual([{ doc_type: 'education_certificate', status: 'reupload_requested', review_note: 'The certificate image is cropped; the seal is not visible.' }, { doc_type: 'pan', status: 'rejected', review_note: "The name on the PAN doesn't match your Aadhaar." }])
    expect((await state(t.teacherId)).verification_status).toBe('under_review') // the teacher's status does not change yet
    expect(await db.selectFrom('user_notifications').select('id').where('user_id', '=', t.userId).execute()).toHaveLength(0)
    expect((await logs(t.teacherId, 'document_rejected'))[0]!.metadata).toEqual({ reasonCode: 'NAME_MISMATCH' })
    expect(await logs(t.teacherId, 'reupload_requested')).toHaveLength(1)
  })

  it('needs a reason from the list and a 10-500 character note (T: Reject without reason)', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id })
    for (const body of [{}, { reasonCode: 'CROPPED' }, { note: 'A perfectly good long note.' }, { reasonCode: 'NOPE', note: 'A perfectly good long note.' }, { reasonCode: 'CROPPED', note: 'short' }, { reasonCode: 'CROPPED', note: 'n'.repeat(501) }]) {
      const res = await post(reviewer, `/teacher-documents/${t.docIds.pan}/reject`, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.message).toBe('Pick a reason and add a note for the teacher.')
    }
    expect((await db.selectFrom('teacher_documents').select('status').where('id', '=', t.docIds.pan!).executeTakeFirstOrThrow()).status).toBe('submitted')
  })

  it('refuses outdated versions, repeats, unclaimed cases and other reviewers\' cases', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id, docs: [...FULL_SET, { type: 'pan', version: 0, current: false }] })
    const old = await db.selectFrom('teacher_documents').select('id').where('teacher_id', '=', t.teacherId).where('is_current', '=', false).executeTakeFirstOrThrow()
    const stale = await post(reviewer, `/teacher-documents/${old.id}/approve`)
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toBe('A newer version of this document was uploaded.')
    expect((await post(reviewer, `/teacher-documents/${t.docIds.aadhaar}/approve`)).status).toBe(200)
    expect((await post(reviewer, `/teacher-documents/${t.docIds.aadhaar}/approve`)).status).toBe(409) // already approved

    const claimedByOther = await post(verifier, `/teacher-documents/${t.docIds.pan}/approve`)
    expect(claimedByOther.status).toBe(409)
    expect(claimedByOther.body.error.message).toBe('Junior is reviewing this case. Take over?')
    expect((await post(superAdmin, `/teacher-documents/${t.docIds.pan}/approve?force=true`)).status).toBe(200)

    const pending = await seedCase({ status: 'pending' })
    const unclaimed = await post(reviewer, `/teacher-documents/${pending.docIds.pan}/approve`)
    expect(unclaimed.status).toBe(409)
    expect(unclaimed.body.error.message).toBe('This teacher is pending.')
    const unowned = await seedCase({ status: 'under_review', claimedBy: null })
    expect((await post(reviewer, `/teacher-documents/${unowned.docIds.pan}/approve`)).body.error.message).toBe('Claim this case first.')
    expect((await post(reviewer, `/teacher-documents/${randomUUID()}/approve`)).status).toBe(404)
    expect((await post(reviewer, '/teacher-documents/nope/approve')).status).toBe(404)
  })

  it('serves an original file only to admins with teacher_documents.unmask, and audits it (FR-16.3, section 22)', async () => {
    const t = await seedCase({ status: 'under_review' })
    expect((await get(reviewer, `/teacher-documents/${t.docIds.aadhaar}/file`)).status).toBe(403)
    const res = await get(verifier, `/teacher-documents/${t.docIds.aadhaar}/file`)
    expect(res.status).toBe(200)
    expect(res.body.data.url).toMatch(/expires=/)
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000)
    expect(await auditOf(t.docIds.aadhaar!, 'teacher_document.unmasked')).toHaveLength(1)
    expect((await get(verifier, `/teacher-documents/${randomUUID()}/file`)).status).toBe(404)
  })
})

describe('notes (FR-16.6)', () => {
  it('stores internal and teacher-visible notes; only the latter reach the teacher', async () => {
    const t = await seedCase({ status: 'pending' })
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/notes`, { note: 'Called the teacher, number is correct.', isInternal: true })).status).toBe(201)
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/notes`, { note: 'Please keep your phone on today.', isInternal: false })).status).toBe(201)
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/notes`, { note: 'Default is internal.' })).status).toBe(201)
    const rows = await logs(t.teacherId, 'note_added')
    expect(rows.map((r) => [r.note, r.is_internal])).toEqual([['Called the teacher, number is correct.', true], ['Please keep your phone on today.', false], ['Default is internal.', true]])
    const caseView = (await get(reviewer, `/teacher-verifications/${t.teacherId}`)).body.data
    expect(caseView.timeline.filter((e: { action: string }) => e.action === 'note_added')).toHaveLength(3)
    expect(await auditOf(t.teacherId, 'teacher_verification.note_added')).toHaveLength(3)
    for (const body of [{}, { note: '' }, { note: 'n'.repeat(2001) }]) expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/notes`, body)).status).toBe(422)
    expect((await post(reviewer, `/teacher-verifications/${randomUUID()}/notes`, { note: 'x' })).status).toBe(404)
  })
})

describe('send back for re-upload (FR-16.7)', () => {
  it('needs at least one flagged document, then notifies the teacher once', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    const none = await post(verifier, `/teacher-verifications/${t.teacherId}/request-reupload`, { message: 'Please upload clearer copies.' })
    expect(none.status).toBe(409)
    expect(none.body.error.message).toBe('Mark at least one document for re-upload.')

    await post(verifier, `/teacher-documents/${t.docIds.pan}/request-reupload`, { reasonCode: 'BLURRY', note: 'The image is blurry; retake it in good light.' })
    await post(verifier, `/teacher-documents/${t.docIds.aadhaar}/reject`, { reasonCode: 'CROPPED', note: 'The corners of the card are cut off.' })
    const res = await post(verifier, `/teacher-verifications/${t.teacherId}/request-reupload`, { message: 'Please upload clearer copies of these two documents.' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ verificationStatus: 'reupload_requested' })
    expect(res.body.data.documents.sort()).toEqual(['aadhaar', 'pan'])
    const row = await state(t.teacherId)
    expect([row.verification_status, row.reviewed_by]).toEqual(['reupload_requested', null])
    const note = await db.selectFrom('user_notifications').select(['title', 'body']).where('user_id', '=', t.userId).executeTakeFirstOrThrow()
    expect(note.title).toBe('Action needed on your application')
    expect(note.body).toMatch(/Aadhaar/)
    expect(note.body).toMatch(/PAN/)
    expect(smsOutbox.find((s) => s.to === t.phone)?.text).toContain('Please upload clearer copies')
    expect((await auditOf(t.teacherId, 'teacher_verification.sent_back'))[0]!.new_values).toEqual({ documents: expect.arrayContaining(['aadhaar', 'pan']) })

    // the mobile app now shows Re-upload Required with the reviewer's notes
    const mobile = await request(app).get(`${APP}/teacher/verification`).set(bearer(t))
    expect(mobile.body.data).toMatchObject({ displayStatus: 'reupload_required', canResubmit: false })
    expect(mobile.body.data.documents.find((d: { docType: string }) => d.docType === 'pan').reviewNote).toBe('The image is blurry; retake it in good light.')
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/request-reupload`, { message: 'Again please, thanks.' })).status).toBe(409) // already sent back
  })

  it('validates the message and the claim', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/request-reupload`, { message: 'short' })).status).toBe(422)
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/request-reupload`, {})).status).toBe(422)
    const other = await seedCase({ status: 'under_review', claimedBy: superAdmin.id })
    expect((await post(verifier, `/teacher-verifications/${other.teacherId}/request-reupload`, { message: 'A long enough message.' })).status).toBe(409)
  })
})

describe('approve (FR-16.8)', () => {
  it('approves a fully verified case: status, badge, logs, audit and an urgent notification', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved })
    const res = await post(verifier, `/teacher-verifications/${t.teacherId}/approve`, { grantBadge: true, note: 'All documents verified; called the teacher.' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ verificationStatus: 'approved', isVerifiedBadge: true })
    const row = await state(t.teacherId)
    expect(row).toMatchObject({ verification_status: 'approved', is_verified_badge: true, badge_granted_by: verifier.id, rejection_reason_code: null })
    expect(row.approved_at).not.toBeNull()
    expect(row.badge_granted_at).not.toBeNull()
    expect((await logs(t.teacherId, 'approved'))[0]).toMatchObject({ from_status: 'under_review', to_status: 'approved', is_internal: false, note: 'All documents verified; called the teacher.' })
    expect(await logs(t.teacherId, 'badge_granted')).toHaveLength(1)
    expect((await auditOf(t.teacherId, 'teacher.approved'))[0]!.new_values).toMatchObject({ grantBadge: true })
    const note = await db.selectFrom('user_notifications').select(['title', 'body', 'data']).where('user_id', '=', t.userId).executeTakeFirstOrThrow()
    expect(note.title).toBe("You're verified! 🎉")
    expect(note.data).toMatchObject({ urgent: true })
    const mobile = await request(app).get(`${APP}/teacher/verification`).set(bearer(t))
    expect(mobile.body.data).toMatchObject({ displayStatus: 'approved', isVerifiedBadge: true })
    expect(mobile.body.data.timeline.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(['Application approved', 'Verified badge granted']))
  })

  it('can skip the badge, and defaults to granting it', async () => {
    const noBadge = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved })
    expect((await post(verifier, `/teacher-verifications/${noBadge.teacherId}/approve`, { grantBadge: false })).body.data.isVerifiedBadge).toBe(false)
    expect((await state(noBadge.teacherId)).is_verified_badge).toBe(false)
    expect(await logs(noBadge.teacherId, 'badge_granted')).toHaveLength(0)
    const dflt = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved })
    expect((await post(verifier, `/teacher-verifications/${dflt.teacherId}/approve`, {})).body.data.isVerifiedBadge).toBe(true)
  })

  it('requires Aadhaar, PAN and a certificate approved, a photo, and reviewed optional documents (T: missing documents)', async () => {
    const msg = 'Approve Aadhaar, PAN and at least one education certificate first.'
    const cases: DocSpec[][] = [
      FULL_SET, // nothing approved yet
      allApproved.filter((d) => d.type !== 'pan'),
      allApproved.map((d) => (d.type === 'education_certificate' ? { ...d, status: 'submitted' } : d)),
      allApproved.filter((d) => d.type !== 'photo'),
      [...allApproved, { type: 'professional_certificate', title: 'Cert', status: 'submitted' }],
    ]
    for (const docs of cases) {
      const t = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs })
      const res = await post(verifier, `/teacher-verifications/${t.teacherId}/approve`, {})
      expect(res.status).toBe(409)
      expect(res.body.error.message).toBe(msg)
      expect((await state(t.teacherId)).verification_status).toBe('under_review')
    }
    const ok = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: [...allApproved, { type: 'experience_letter', title: 'Letter', status: 'rejected' }] })
    expect((await post(verifier, `/teacher-verifications/${ok.teacherId}/approve`, {})).status).toBe(200) // a rejected optional document does not block
  })

  it('blocks a duplicate identity, unless a Super Admin overrides it with a reason (T: duplicate identity)', async () => {
    const first = await seedCase({ status: 'approved', docs: [{ type: 'aadhaar', hash: 'h-approve-dup', status: 'approved' }] })
    const code = (await state(first.teacherId)).public_code
    const docs = allApproved.map((d) => (d.type === 'aadhaar' ? { ...d, hash: 'h-approve-dup' } : d))
    const t = await seedCase({ status: 'under_review', claimedBy: superAdmin.id, docs })
    const blocked = await post(superAdmin, `/teacher-verifications/${t.teacherId}/approve`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toBe(`This Aadhaar is already used by ${code}.`)
    expect(blocked.body.error.details.duplicates[0]).toMatchObject({ publicCode: code })

    const noReason = await post(superAdmin, `/teacher-verifications/${t.teacherId}/approve`, { overrideDuplicate: true })
    expect(noReason.status).toBe(422)
    const t2 = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs })
    const notSuper = await post(verifier, `/teacher-verifications/${t2.teacherId}/approve`, { overrideDuplicate: true, reason: 'Same person, second account' })
    expect(notSuper.status).toBe(403)
    const ok = await post(superAdmin, `/teacher-verifications/${t.teacherId}/approve`, { overrideDuplicate: true, reason: 'Same person re-registered after a phone change' })
    expect(ok.status).toBe(200)
    expect((await auditOf(t.teacherId, 'teacher_verification.duplicate_overridden'))[0]!.reason).toBe('Same person re-registered after a phone change')
  })

  it("won't let an admin approve a teacher they created (T: maker-checker)", async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved, createdBy: verifier.id })
    const res = await post(verifier, `/teacher-verifications/${t.teacherId}/approve`, {})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Another admin must approve a teacher you created.' })
    const other = await createAdminWithToken({ roles: ['verification_admin'] })
    expect((await post(other, `/teacher-verifications/${t.teacherId}/approve?force=true`, {})).status).toBe(200)
  })

  it('needs the decide permission, an active claim and a reviewable status', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id, docs: allApproved })
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/approve`, {})).status).toBe(403) // review is not decide
    const other = await seedCase({ status: 'under_review', claimedBy: superAdmin.id, docs: allApproved })
    expect((await post(verifier, `/teacher-verifications/${other.teacherId}/approve`, {})).status).toBe(409)
    for (const status of ['pending', 'approved', 'rejected', 'reupload_requested'] as const) {
      const s = await seedCase({ status, docs: allApproved })
      const res = await post(verifier, `/teacher-verifications/${s.teacherId}/approve`, {})
      expect(res.status, status).toBe(409)
      expect(res.body.error.message).toBe(`This teacher is ${status.replace('_', ' ')}.`)
    }
  })

  it('starts the 12-month registration period at approval when the fee was paid (FR-16.8 step 3)', async () => {
    const paid = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved, txn: 'captured' })
    await db.updateTable('transactions').set({ payment_configuration_id: (await db.selectFrom('payment_configurations').select('id').where('fee_code', '=', 'TEACHER_REGISTRATION').where('status', '=', 'active').executeTakeFirstOrThrow()).id }).where('user_id', '=', paid.userId).execute()
    const res = await post(verifier, `/teacher-verifications/${paid.teacherId}/approve`, {})
    expect(res.body.data.subscriptionId).toBeTruthy()
    const sub = await db.selectFrom('subscriptions').selectAll().where('user_id', '=', paid.userId).executeTakeFirstOrThrow()
    expect(sub).toMatchObject({ subscriber_type: 'teacher', fee_code: 'TEACHER_REGISTRATION', status: 'active' })
    expect(sub.ends_at!.getTime() - sub.starts_at.getTime()).toBe(365 * 86_400_000)
    const free = await seedCase({ status: 'under_review', claimedBy: verifier.id, docs: allApproved })
    expect((await post(verifier, `/teacher-verifications/${free.teacherId}/approve`, {})).body.data.subscriptionId).toBeNull()
    expect(await db.selectFrom('subscriptions').select('id').where('user_id', '=', free.userId).execute()).toHaveLength(0)
  })
})

describe('reject (FR-16.9)', () => {
  it('rejects with a reason the teacher sees, by notification and SMS', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    const res = await post(verifier, `/teacher-verifications/${t.teacherId}/reject`, { reasonCode: 'NAME_MISMATCH', note: "The name on your PAN card doesn't match your Aadhaar. Please re-apply." })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ verificationStatus: 'rejected', reasonCode: 'NAME_MISMATCH', refundCreated: false })
    const row = await state(t.teacherId)
    expect(row).toMatchObject({ verification_status: 'rejected', rejection_reason_code: 'NAME_MISMATCH', rejection_note: "The name on your PAN card doesn't match your Aadhaar. Please re-apply.", reviewed_by: null, account_status: 'active' })
    expect(row.rejected_at).not.toBeNull()
    expect((await logs(t.teacherId, 'rejected'))[0]).toMatchObject({ is_internal: false, metadata: { reasonCode: 'NAME_MISMATCH' } })
    expect((await db.selectFrom('user_notifications').select('title').where('user_id', '=', t.userId).executeTakeFirstOrThrow()).title).toBe('Update on your application')
    expect(smsOutbox.find((s) => s.to === t.phone)?.text).toContain("doesn't match your Aadhaar")
    const mobile = await request(app).get(`${APP}/teacher/verification`).set(bearer(t))
    expect(mobile.body.data).toMatchObject({ displayStatus: 'rejected', rejectionReasonCode: 'NAME_MISMATCH', reapplyBlocked: false })
  })

  it('needs a valid reason code and note (T: Reject without reason)', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    for (const body of [{}, { reasonCode: 'NAME_MISMATCH' }, { reasonCode: 'BLURRY', note: 'This code is for documents only.' }, { reasonCode: 'OTHER', note: 'too short' }]) {
      const res = await post(verifier, `/teacher-verifications/${t.teacherId}/reject`, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect(res.body.error.message).toBe('Pick a reason and add a note for the teacher.')
    }
    expect((await state(t.teacherId)).verification_status).toBe('under_review')
  })

  it('suspends the account and signs the teacher out on FORGED_DOCUMENT', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    await db.insertInto('app_sessions').values({ user_id: t.userId, refresh_token_hash: randomUUID(), token_family: randomUUID(), auth_method: 'otp', expires_at: new Date(Date.now() + 86_400_000) }).execute()
    expect((await post(verifier, `/teacher-verifications/${t.teacherId}/reject`, { reasonCode: 'FORGED_DOCUMENT', note: 'The Aadhaar document has been altered.' })).status).toBe(200)
    expect(await state(t.teacherId)).toMatchObject({ account_status: 'suspended', suspension_reason: 'FORGED_DOCUMENT' })
    expect(await db.selectFrom('app_users').select(['account_status', 'suspended_reason']).where('id', '=', t.userId).executeTakeFirstOrThrow()).toEqual({ account_status: 'suspended', suspended_reason: 'FORGED_DOCUMENT' })
    expect((await db.selectFrom('app_sessions').select('revoked_reason').where('user_id', '=', t.userId).executeTakeFirstOrThrow()).revoked_reason).toBe('account_suspended')
    expect(await logs(t.teacherId, 'suspended')).toHaveLength(1)
    const mobile = await request(app).get(`${APP}/teacher/verification`).set(bearer(t))
    expect(mobile.body.data).toMatchObject({ reapplyBlocked: true })
  })

  it('creates an auto-approved refund request when the registration fee was captured', async () => {
    const paid = await seedCase({ status: 'under_review', claimedBy: verifier.id, txn: 'captured' })
    const res = await post(verifier, `/teacher-verifications/${paid.teacherId}/reject`, { reasonCode: 'DOC_UNREADABLE', note: 'We could not read your documents; please re-apply.' })
    expect(res.body.data.refundCreated).toBe(true)
    const refunds = await db.selectFrom('refunds').selectAll().where('transaction_id', '=', (await state(paid.teacherId)).registration_transaction_id!).execute()
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ reason_code: 'teacher_rejected', status: 'approved', requested_by_type: 'system', decided_by: verifier.id })
    expect(Number(refunds[0]!.amount_paise)).toBe(49900)
    expect((await auditOf(paid.teacherId, 'teacher.rejected'))[0]!.new_values).toMatchObject({ refundCreated: true })

    const unpaid = await seedCase({ status: 'under_review', claimedBy: verifier.id, txn: 'created' })
    expect((await post(verifier, `/teacher-verifications/${unpaid.teacherId}/reject`, { reasonCode: 'OTHER', note: 'We cannot approve this application.' })).body.data.refundCreated).toBe(false)
  })

  it('needs decide, an active claim and a reviewable status', async () => {
    const t = await seedCase({ status: 'under_review', claimedBy: reviewer.id })
    expect((await post(reviewer, `/teacher-verifications/${t.teacherId}/reject`, { reasonCode: 'OTHER', note: 'We cannot approve this application.' })).status).toBe(403)
    const pending = await seedCase({ status: 'pending' })
    expect((await post(verifier, `/teacher-verifications/${pending.teacherId}/reject`, { reasonCode: 'OTHER', note: 'We cannot approve this application.' })).status).toBe(409)
  })
})

describe('POST /teachers (manual creation, FR-16.10)', () => {
  const makeFile = async () => (await db.insertInto('files').values({ bucket: 'gc-private', object_key: `test/${randomUUID()}.jpg`, original_name: 'doc', mime_type: 'image/jpeg', size_bytes: 10, purpose: 'teacher_document', uploaded_by_type: 'admin', status: 'uploaded' }).returning('id').executeTakeFirstOrThrow()).id
  const body = async (over: Record<string, unknown> = {}) => ({
    fullName: 'Kavya Menon',
    phone: `+919${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
    email: null,
    gender: 'female',
    dateOfBirth: '1994-06-12',
    categoryId: m.categories.homeTutor,
    highestQualification: 'B.Sc., B.Ed. (Primary)',
    experienceYears: 4,
    documents: [{ docType: 'aadhaar', fileId: await makeFile(), docNumberLast4: '4821' }, { docType: 'pan', fileId: await makeFile(), docNumberLast4: '4F' + '12' }, { docType: 'education_certificate', fileId: await makeFile(), title: 'B.Ed. 2019' }, { docType: 'photo', fileId: await makeFile() }],
    submitForReview: false,
    ...over,
  })
  const creator = async () => createAdminWithToken({ roles: ['operations_admin'] })

  it('creates a draft teacher with documents for someone who cannot use the app', async () => {
    const admin = await creator()
    const payload = await body()
    const res = await post(admin, '/teachers', payload)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    phones.push(payload.phone)
    expect(res.body.data).toMatchObject({ publicCode: expect.stringMatching(/^GC-T/), verificationStatus: 'draft' })
    const row = await state(res.body.data.id)
    expect(row).toMatchObject({ created_by: admin.id, verification_status: 'draft', submitted_at: null, phone: payload.phone })
    const user = await db.selectFrom('app_users').select(['user_type', 'signup_source', 'phone']).where('id', '=', row.user_id).executeTakeFirstOrThrow()
    expect(user).toEqual({ user_type: 'teacher', signup_source: 'admin_created', phone: payload.phone })
    const docs = await db.selectFrom('teacher_documents').select(['doc_type', 'doc_number_masked', 'doc_number_hash']).where('teacher_id', '=', res.body.data.id).orderBy('doc_type').execute()
    expect(docs.find((d) => d.doc_type === 'aadhaar')).toMatchObject({ doc_number_masked: 'XXXX XXXX 4821', doc_number_hash: null })
    expect((await auditOf(res.body.data.id, 'teacher.created_manually'))[0]!.new_values).toMatchObject({ createdBy: admin.id })
  })

  it('can submit straight into the queue, and a different admin must approve it', async () => {
    const admin = await creator()
    const payload = await body({ submitForReview: true })
    const res = await post(admin, '/teachers', payload)
    expect(res.status).toBe(201)
    phones.push(payload.phone)
    expect(res.body.data.verificationStatus).toBe('pending')
    const row = await state(res.body.data.id)
    expect(row.submitted_at).not.toBeNull()
    expect((await logs(res.body.data.id, 'submitted'))[0]).toMatchObject({ admin_id: admin.id, from_status: 'draft', to_status: 'pending' })
    const queue = await get(verifier, `/teacher-verifications?q=${row.public_code}`)
    expect(queue.body.data.map((r: { teacherId: string }) => r.teacherId)).toEqual([res.body.data.id])
  })

  it('refuses submitting without the required documents, and bad input', async () => {
    const admin = await creator()
    const partial = await body({ submitForReview: true })
    partial.documents = partial.documents.slice(0, 2)
    const res = await post(admin, '/teachers', partial)
    expect(res.status).toBe(422)
    expect(res.body.error.message).toContain('required documents')
    for (const over of [{ fullName: 'A' }, { phone: '12345' }, { gender: 'x' }, { dateOfBirth: '2015-01-01' }, { dateOfBirth: '1900-01-01' }, { categoryId: randomUUID() }, { experienceYears: 61 }, { highestQualification: 'B' }, { email: 'nope' }, { documents: [{ docType: 'education_certificate', fileId: await makeFile() }] }, { documents: [{ docType: 'photo', fileId: randomUUID() }] }, { extra: 1 }]) {
      const r = await post(admin, '/teachers', await body(over))
      expect(r.status, JSON.stringify(over).slice(0, 60)).toBe(422)
    }
  })

  it('refuses a phone or email that already has an account', async () => {
    const admin = await creator()
    const existing = await seedCase({ status: 'pending' })
    const dupPhone = await post(admin, '/teachers', await body({ phone: existing.phone }))
    expect(dupPhone.status).toBe(409)
    expect(dupPhone.body.error.code).toBe('CONFLICT_DUPLICATE')
    const email = `tv-test-${randomUUID()}@example.com`
    await db.updateTable('app_users').set({ email }).where('id', '=', existing.userId).execute()
    expect((await post(admin, '/teachers', await body({ email }))).status).toBe(409)
  })

  it('needs teachers.create', async () => {
    expect((await post(verifier, '/teachers', await body())).status).toBe(403)
    expect((await post(reviewer, '/teachers', await body())).status).toBe(403)
  })
})

describe('background jobs', () => {
  it('releases claims idle for 30 minutes and leaves active ones alone (FR-16.2)', async () => {
    const idle = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    const busy = await seedCase({ status: 'under_review', claimedBy: verifier.id })
    await db.insertInto('teacher_verification_logs').values([
      { teacher_id: idle.teacherId, action: 'assigned', admin_id: verifier.id, is_internal: true, created_at: new Date(Date.now() - 45 * 60_000) },
      { teacher_id: busy.teacherId, action: 'document_approved', admin_id: verifier.id, is_internal: false, created_at: new Date(Date.now() - 5 * 60_000) },
    ]).execute()
    await db.updateTable('teachers').set({ updated_at: new Date(Date.now() - 2 * HOUR) }).where('id', 'in', [idle.teacherId, busy.teacherId]).execute()
    expect(await releaseStaleClaims()).toBeGreaterThanOrEqual(1)
    expect(await state(idle.teacherId)).toMatchObject({ reviewed_by: null, verification_status: 'pending' })
    expect(await state(busy.teacherId)).toMatchObject({ reviewed_by: verifier.id, verification_status: 'under_review' })
    expect((await logs(idle.teacherId, 'assigned')).pop()!.note).toBe('Claim expired after 30 minutes of inactivity')
  })

  it('runs automated checks once per submission: duplicate identity and age (FR-16.4)', async () => {
    await seedCase({ status: 'approved', docs: [{ type: 'pan', hash: 'h-check-dup', status: 'approved' }] })
    const dup = await seedCase({ status: 'pending', docs: [{ type: 'pan', hash: 'h-check-dup' }] })
    const young = await seedCase({ status: 'pending' })
    await db.updateTable('teachers').set({ date_of_birth: new Date(Date.now() - 16 * 365 * 86_400_000).toISOString().slice(0, 10) }).where('id', '=', young.teacherId).execute()
    await runPendingChecks()
    const check = async (id: string, type: string) => (await logs(id, 'auto_check')).map((l) => l.metadata as { type: string; result: string }).find((x) => x.type === type)
    expect(await check(dup.teacherId, 'duplicate_identity')).toMatchObject({ result: 'fail' })
    expect(await check(young.teacherId, 'age')).toMatchObject({ result: 'fail' })
    expect(await check(young.teacherId, 'duplicate_identity')).toMatchObject({ result: 'pass' })
    const before = (await logs(dup.teacherId, 'auto_check')).length
    await runPendingChecks()
    expect((await logs(dup.teacherId, 'auto_check')).length).toBe(before) // not re-run until the teacher resubmits
    const row = (await get(verifier, `/teacher-verifications?q=${(await state(dup.teacherId)).public_code}`)).body.data[0]
    expect(row.checks.duplicate).toBe('fail')

    await db.insertInto('teacher_verification_logs').values({ teacher_id: dup.teacherId, action: 'resubmitted', is_internal: false, created_at: new Date(Date.now() + 1000) }).execute()
    await runPendingChecks()
    expect((await logs(dup.teacherId, 'auto_check')).length).toBeGreaterThan(before)
  })

  it('e-mails opted-in reviewers once about a case past 24 hours (FR-16.11)', async () => {
    const t = await seedCase({ status: 'pending', submittedAgoHours: 26 })
    const optedOut = await createAdminWithToken({ roles: ['verification_admin'] })
    await db.insertInto('admin_profiles').values({ admin_id: optedOut.id, notification_prefs: JSON.stringify({ email_digest: true, queue_alerts: false }) as never }).execute()
    expect(await sendSlaAlerts()).toBeGreaterThanOrEqual(1)
    const mails = outbox.filter((o) => o.subject.includes('past 24 hours'))
    expect(mails.length).toBeGreaterThan(0)
    expect(mails.some((o) => o.to === verifier.email)).toBe(true)
    expect(mails.some((o) => o.to === optedOut.email)).toBe(false)
    expect(mails.some((o) => o.to === reviewer.email)).toBe(true)
    const code = (await state(t.teacherId)).public_code
    expect(mails[0]!.text).toContain(code)
    outbox.length = 0
    await sendSlaAlerts() // the same case is not announced twice
    expect(outbox.some((o) => o.text.includes(code))).toBe(false)
  })
})
