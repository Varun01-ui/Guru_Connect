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

async function newTeacher(over: Parameters<typeof createTeacher>[1] = {}): Promise<TestTeacher> {
  const t = await createTeacher(m, { status: 'pending', ...over })
  phones.push(t.phone)
  return t
}
const get = (t: { token: string }) => request(app).get(`${APP}/teacher/verification`).set(bearer(t))
const resubmit = (t: { token: string }) => request(app).post(`${APP}/teacher/verification/resubmit`).set(bearer(t))

async function addDoc(teacherId: string, docType: string, over: { status?: string; version?: number; current?: boolean; note?: string } = {}) {
  const user = await db.selectFrom('teachers').select('user_id').where('id', '=', teacherId).executeTakeFirstOrThrow()
  const file = await db
    .insertInto('files')
    .values({ bucket: 'gc-private', object_key: `test/${teacherId}/${docType}/${Math.random()}.jpg`, original_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 10, purpose: 'teacher_document', uploaded_by_type: 'app_user', uploaded_by_id: user.user_id, status: 'uploaded' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return db
    .insertInto('teacher_documents')
    .values({ teacher_id: teacherId, doc_type: docType as 'aadhaar', file_id: file.id, version: over.version ?? 1, is_current: over.current ?? true, status: (over.status ?? 'submitted') as 'submitted', review_note: over.note ?? null })
    .returning('id')
    .executeTakeFirstOrThrow()
}

async function addLog(teacherId: string, action: string, over: { internal?: boolean; documentId?: string; at?: Date } = {}) {
  await db
    .insertInto('teacher_verification_logs')
    .values({ teacher_id: teacherId, action, is_internal: over.internal ?? false, document_id: over.documentId ?? null, ...(over.at ? { created_at: over.at } : {}) })
    .execute()
}

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('GET /teacher/verification', () => {
  it('maps pending and under_review to the same display status (T16.1)', async () => {
    for (const status of ['pending', 'under_review'] as const) {
      const t = await newTeacher({ status })
      const res = await get(t)
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ verificationStatus: status, displayStatus: 'pending', canResubmit: false })
    }
  })

  it('404s for a draft teacher and is teacher-only', async () => {
    const draft = await newTeacher({ status: 'draft' })
    const res = await get(draft)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect((await request(app).get(`${APP}/teacher/verification`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/verification`)).status).toBe(401)
  })

  it('lists the document checklist with review notes for flagged documents only (T16.2)', async () => {
    const t = await newTeacher({ status: 'reupload_requested' })
    await addDoc(t.teacherId, 'aadhaar', { status: 'approved', note: 'internal-ish ok' })
    await addDoc(t.teacherId, 'pan', { status: 'reupload_requested', note: 'The image is blurry — please retake it in good light.' })
    await addDoc(t.teacherId, 'education_certificate', { status: 'approved' })
    await addDoc(t.teacherId, 'photo', { status: 'approved' })
    await addDoc(t.teacherId, 'photo', { status: 'rejected', current: false, version: 0 }) // old versions are not listed
    const res = await get(t)
    expect(res.body.data.displayStatus).toBe('reupload_required')
    expect(res.body.data.documents).toEqual([
      { docType: 'aadhaar', status: 'approved' },
      { docType: 'pan', status: 'reupload_requested', reviewNote: 'The image is blurry — please retake it in good light.', replaced: false },
      { docType: 'education_certificate', status: 'approved' },
      { docType: 'photo', status: 'approved' },
    ])
    expect(res.body.data.canResubmit).toBe(false)
  })

  it('never returns internal rows or non-surfaced actions, oldest first, last 20 (T16.9)', async () => {
    const t = await newTeacher({ status: 'pending' })
    const base = Date.now() - 100_000
    await addLog(t.teacherId, 'submitted', { at: new Date(base) })
    await addLog(t.teacherId, 'assigned', { internal: false, at: new Date(base + 1000) })
    await addLog(t.teacherId, 'note_added', { internal: false, at: new Date(base + 2000) })
    await addLog(t.teacherId, 'auto_check', { internal: false, at: new Date(base + 3000) })
    await addLog(t.teacherId, 'document_approved', { internal: true, at: new Date(base + 4000) })
    const pan = await addDoc(t.teacherId, 'pan', { status: 'approved' })
    await addLog(t.teacherId, 'document_approved', { documentId: pan.id, at: new Date(base + 5000) })
    const res = await get(t)
    expect(res.body.data.timeline.map((e: { event: string; label: string }) => [e.event, e.label])).toEqual([
      ['submitted', 'Application submitted'],
      ['document_approved', 'PAN approved'],
    ])
    expect(res.body.data.timeline[1].docType).toBe('pan')
  })

  it('keeps only the latest 20 events', async () => {
    const t = await newTeacher({ status: 'pending' })
    for (let i = 0; i < 25; i++) await addLog(t.teacherId, 'resubmitted', { at: new Date(Date.now() - (30 - i) * 1000) })
    const res = await get(t)
    expect(res.body.data.timeline).toHaveLength(20)
    const times = res.body.data.timeline.map((e: { at: string }) => e.at)
    expect([...times].sort()).toEqual(times)
  })

  it('shows the verified badge event only when the badge is granted', async () => {
    const t = await newTeacher({ status: 'approved', verified: false })
    await addLog(t.teacherId, 'badge_granted')
    expect((await get(t)).body.data.timeline).toEqual([])
    await db.updateTable('teachers').set({ is_verified_badge: true }).where('id', '=', t.teacherId).execute()
    const res = await get(t)
    expect(res.body.data).toMatchObject({ displayStatus: 'approved', isVerifiedBadge: true })
    expect(res.body.data.timeline.map((e: { label: string }) => e.label)).toEqual(['Verified badge granted'])
    expect(typeof res.body.data.profileCompleteness).toBe('number')
  })

  it('explains a rejection and counts the 30-day re-apply window (T16.6, T16.7)', async () => {
    const rejectedAt = new Date(Date.now() - 10 * 86_400_000)
    const t = await newTeacher({ status: 'pending' })
    await db.updateTable('teachers').set({ verification_status: 'rejected', rejected_at: rejectedAt, rejection_reason_code: 'NAME_MISMATCH', rejection_note: "The name on your PAN card doesn't match your Aadhaar." }).where('id', '=', t.teacherId).execute()
    await addLog(t.teacherId, 'rejected')
    const res = await get(t)
    expect(res.body.data).toMatchObject({
      verificationStatus: 'rejected',
      displayStatus: 'rejected',
      rejectionReasonCode: 'NAME_MISMATCH',
      rejectionMessage: "The name on your documents didn't match.",
      rejectionNote: "The name on your PAN card doesn't match your Aadhaar.",
      rejectedAt: rejectedAt.toISOString(),
      canReapplyAt: new Date(rejectedAt.getTime() + 30 * 86_400_000).toISOString(),
      reapplyBlocked: false,
    })
    expect(res.body.data.timeline[0]).toMatchObject({ event: 'rejected', label: 'Application rejected', reason: "The name on your documents didn't match." })

    await db.updateTable('teachers').set({ rejection_reason_code: 'FORGED_DOCUMENT' }).where('id', '=', t.teacherId).execute()
    expect((await get(t)).body.data.reapplyBlocked).toBe(true)
    await db.updateTable('teachers').set({ rejection_reason_code: 'SOMETHING_NEW' }).where('id', '=', t.teacherId).execute()
    expect((await get(t)).body.data.rejectionMessage).toBe("Your application wasn't approved this time.")
  })

  it('marks a flagged document as replaced once a newer submitted version exists', async () => {
    const t = await newTeacher({ status: 'reupload_requested' })
    await addDoc(t.teacherId, 'pan', { status: 'rejected', current: false, version: 1 })
    await addDoc(t.teacherId, 'pan', { status: 'submitted', version: 2 })
    const res = await get(t)
    expect(res.body.data.documents).toEqual([{ docType: 'pan', status: 'submitted', replaced: true }])
    expect(res.body.data.canResubmit).toBe(true)
  })
})

describe('POST /teacher/verification/resubmit', () => {
  it('is blocked while a flagged document has not been replaced, then allowed (T16.3)', async () => {
    const t = await newTeacher({ status: 'reupload_requested' })
    await addDoc(t.teacherId, 'aadhaar', { status: 'approved' })
    await addDoc(t.teacherId, 'pan', { status: 'reupload_requested', note: 'Blurry' })
    const blocked = await resubmit(t)
    expect(blocked.status).toBe(422)
    expect(blocked.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Upload the remaining documents first.', details: { pending: ['pan'] } })
    expect((await db.selectFrom('teachers').select('verification_status').where('id', '=', t.teacherId).executeTakeFirstOrThrow()).verification_status).toBe('reupload_requested')

    // Module 15 replaces the flagged PAN: a fresh current row, status submitted
    await db.updateTable('teacher_documents').set({ is_current: false }).where('teacher_id', '=', t.teacherId).where('doc_type', '=', 'pan').execute()
    await addDoc(t.teacherId, 'pan', { status: 'submitted', version: 2 })
    const ok = await resubmit(t)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ verificationStatus: 'pending', displayStatus: 'pending' })
  })

  it('moves to pending without touching submitted_at, logs, audits and notifies (T16.4)', async () => {
    const submittedAt = new Date(Date.now() - 6 * 86_400_000)
    const t = await newTeacher({ status: 'reupload_requested' })
    await db.updateTable('teachers').set({ submitted_at: submittedAt }).where('id', '=', t.teacherId).execute()
    await addDoc(t.teacherId, 'pan', { status: 'rejected', current: false, version: 1 })
    await addDoc(t.teacherId, 'pan', { status: 'submitted', version: 2 })
    const res = await resubmit(t)
    expect(res.status).toBe(200)
    expect(res.body.data.submittedAt).toBe(submittedAt.toISOString())

    const row = await db.selectFrom('teachers').select(['verification_status', 'submitted_at']).where('id', '=', t.teacherId).executeTakeFirstOrThrow()
    expect(row.verification_status).toBe('pending')
    expect(row.submitted_at!.toISOString()).toBe(submittedAt.toISOString())
    const logs = await db.selectFrom('teacher_verification_logs').select(['action', 'from_status', 'to_status', 'is_internal']).where('teacher_id', '=', t.teacherId).execute()
    expect(logs).toEqual([{ action: 'resubmitted', from_status: 'reupload_requested', to_status: 'pending', is_internal: false }])
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_verification_resubmitted').executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ fromStatus: 'reupload_requested', documentsReplaced: ['pan'] })
    expect(await db.selectFrom('user_notifications').select('category').where('user_id', '=', t.userId).execute()).toEqual([{ category: 'verification' }])
    expect((await get(t)).body.data.timeline.map((e: { label: string }) => e.label)).toEqual(['Re-submitted'])
  })

  it('answers CONFLICT_STATE when the application is not waiting for documents', async () => {
    for (const status of ['pending', 'under_review', 'approved', 'rejected', 'draft'] as const) {
      const t = await newTeacher({ status })
      const res = await resubmit(t)
      expect(res.status, status).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT_STATE')
    }
  })

  it('is teacher-only', async () => {
    expect((await request(app).post(`${APP}/teacher/verification/resubmit`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).post(`${APP}/teacher/verification/resubmit`)).status).toBe(401)
  })

  it('works end to end with Module 15 uploads', async () => {
    const t = await newTeacher({ status: 'reupload_requested' })
    const aadhaar = await addDoc(t.teacherId, 'photo', { status: 'reupload_requested', note: 'Retake' })
    expect(aadhaar.id).toBeTruthy()
    expect((await resubmit(t)).status).toBe(422)
    const { fileId } = await uploadFile(app, t, { purpose: 'teacher_document' })
    const up = await request(app).post(`${APP}/teacher/documents`).set(bearer(t)).send({ docType: 'photo', fileId })
    expect(up.status).toBe(201)
    expect((await resubmit(t)).status).toBe(200)
  })
})
