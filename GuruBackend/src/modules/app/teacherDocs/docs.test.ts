import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { verhoeffCheckDigit } from '../../../lib/verhoeff.js'
import { APP, bearer, createParent, deleteParent, loadMasters, purgeUsersByPhone, randomPhone, registrationToken, uploadFile } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent

const aadhaar = (() => {
  const base = '49123456789'
  return base + verhoeffCheckDigit(base)
})()

type T = { token: string; userId: string; teacherId: string; phone: string }

async function newTeacher(): Promise<T> {
  const phone = randomPhone()
  phones.push(phone)
  const res = await request(app)
    .post(`${APP}/registration/teacher`)
    .set('Authorization', `Bearer ${registrationToken(phone).token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ fullName: 'Kavya Menon', gender: 'female', dateOfBirth: '1994-06-12', categoryId: m.categories.homeTutor })
  expect(res.status).toBe(201)
  const user = await db.selectFrom('app_users').select('id').where('phone', '=', phone).executeTakeFirstOrThrow()
  return { token: res.body.data.accessToken, userId: user.id, teacherId: res.body.data.teacherId, phone }
}

const api = (t: { token: string }) => ({
  get: (p: string) => request(app).get(`${APP}${p}`).set(bearer(t)),
  del: (p: string) => request(app).delete(`${APP}${p}`).set(bearer(t)),
  post: (p: string, body: object, key?: string) => {
    const r = request(app).post(`${APP}${p}`).set(bearer(t))
    return (key ? r.set('Idempotency-Key', key) : r).send(body)
  },
})

async function upload(t: T, mime: 'image/jpeg' | 'image/png' | 'application/pdf' = 'image/jpeg') {
  const { fileId, confirmed } = await uploadFile(app, t, { purpose: 'teacher_document', mimeType: mime })
  expect(confirmed.status).toBe(200)
  return fileId
}

async function addDoc(t: T, docType: string, extra: Record<string, unknown> = {}, mime: 'image/jpeg' | 'image/png' | 'application/pdf' = 'image/jpeg') {
  return api(t).post('/teacher/documents', { docType, fileId: await upload(t, mime), ...extra })
}

async function addRequiredDocs(t: T) {
  expect((await addDoc(t, 'aadhaar', { docNumber: aadhaar })).status).toBe(201)
  expect((await addDoc(t, 'pan', { docNumber: 'ABCDE1234F' })).status).toBe(201)
  expect((await addDoc(t, 'education_certificate', { title: 'M.Sc. Physics, Bangalore University 2010' }, 'application/pdf')).status).toBe(201)
  expect((await addDoc(t, 'photo')).status).toBe(201)
}

const setStatus = (teacherId: string, status: string) => db.updateTable('teachers').set({ verification_status: status as 'pending' }).where('id', '=', teacherId).execute()

async function capturedTxn(userId: string, over: Partial<{ fee_code: string; purpose: string; status: string }> = {}) {
  return db
    .insertInto('transactions')
    .values({
      user_id: userId,
      payer_type: 'teacher',
      purpose: (over.purpose ?? 'teacher_registration') as 'teacher_registration',
      fee_code: over.fee_code ?? 'TEACHER_REGISTRATION',
      amount_paise: 49900,
      base_amount_paise: 42288,
      gst_paise: 7612,
      status: (over.status ?? 'captured') as 'captured',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
})

afterAll(async () => {
  await purgeUsersByPhone(phones)
  await deleteParent(parent)
  await pool.end()
})

describe('POST /teacher/documents', () => {
  it('stores Aadhaar and PAN masked and hashed, never in full (BR-15.2)', async () => {
    const t = await newTeacher()
    const a = await addDoc(t, 'aadhaar', { docNumber: `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}` })
    expect(a.status).toBe(201)
    expect(a.body.data).toMatchObject({ docType: 'aadhaar', status: 'submitted', numberMasked: `XXXX XXXX ${aadhaar.slice(-4)}`, version: 1 })
    const p = await addDoc(t, 'pan', { docNumber: 'abcde1234f' })
    expect(p.body.data.numberMasked).toBe('AXXXXX234F')

    const rows = await db.selectFrom('teacher_documents').selectAll().where('teacher_id', '=', t.teacherId).execute()
    const aRow = rows.find((r) => r.doc_type === 'aadhaar')!
    expect(aRow.doc_number_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(aadhaar)
    const audit = await db.selectFrom('audit_logs').select(['new_values']).where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_document_uploaded').execute()
    expect(audit).toHaveLength(2)
    expect(JSON.stringify(audit)).not.toContain(aadhaar)
    expect(JSON.stringify(a.body)).not.toContain(aadhaar)

    const list = await api(t).get('/teacher/documents')
    expect(JSON.stringify(list.body)).not.toContain(aadhaar)
    expect(list.body.data.documents.aadhaar.thumbnailUrl).toMatch(/^http/)
  })

  it('computes the same hash for the same number so duplicates can be detected', async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    await addDoc(a, 'aadhaar', { docNumber: aadhaar })
    await addDoc(b, 'aadhaar', { docNumber: aadhaar })
    const hashes = await db.selectFrom('teacher_documents').select('doc_number_hash').where('teacher_id', 'in', [a.teacherId, b.teacherId]).execute()
    expect(hashes[0]!.doc_number_hash).toBe(hashes[1]!.doc_number_hash)
  })

  it('validates numbers, titles, linked qualification and file type (T15.3)', async () => {
    const t = await newTeacher()
    const bad = '491234567891' // wrong check digit
    for (const [docType, extra] of [
      ['aadhaar', { docNumber: bad }],
      ['aadhaar', { docNumber: '1234' }],
      ['aadhaar', {}],
      ['pan', { docNumber: 'ABCDE12345' }],
      ['pan', {}],
      ['education_certificate', {}],
      ['education_certificate', { title: 'x' }],
      ['professional_certificate', {}],
      ['experience_letter', { title: '' }],
      ['education_certificate', { title: 'B.Ed. 2010', qualificationId: randomUUID() }],
      ['photo', { qualificationId: randomUUID() }],
    ] as [string, Record<string, unknown>][]) {
      const res = await addDoc(t, docType, extra)
      expect(res.status, `${docType} ${JSON.stringify(extra)}`).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect((await api(t).post('/teacher/documents', { docType: 'passport', fileId: randomUUID() })).status).toBe(422)
    expect((await api(t).get('/teacher/documents')).body.data.documents.aadhaar).toBeNull()
  })

  it('applies per-type file rules and ownership', async () => {
    const t = await newTeacher()
    const pdfForAadhaar = await addDoc(t, 'aadhaar', { docNumber: aadhaar }, 'application/pdf')
    expect(pdfForAadhaar.status).toBe(415)
    expect(pdfForAadhaar.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    expect((await addDoc(t, 'photo', {}, 'application/pdf')).status).toBe(415)
    expect((await addDoc(t, 'education_certificate', { title: 'B.Ed. 2010' }, 'application/pdf')).status).toBe(201)
    expect((await addDoc(t, 'pan', { docNumber: 'ABCDE1234F' }, 'image/png')).status).toBe(201)

    const other = await newTeacher()
    const theirFile = await upload(other)
    expect((await api(t).post('/teacher/documents', { docType: 'photo', fileId: theirFile })).status).toBe(422)

    const pendingFile = (await request(app).post(`${APP}/uploads/presign`).set(bearer(t)).send({ purpose: 'teacher_document', mimeType: 'image/jpeg', sizeBytes: 100, fileName: 'a.jpg' })).body.data.fileId
    expect((await api(t).post('/teacher/documents', { docType: 'photo', fileId: pendingFile })).status).toBe(422) // never confirmed

    const avatar = (await uploadFile(app, t, { purpose: 'avatar' })).fileId
    expect((await api(t).post('/teacher/documents', { docType: 'photo', fileId: avatar })).status).toBe(422) // wrong purpose

    const used = await upload(t)
    expect((await api(t).post('/teacher/documents', { docType: 'photo', fileId: used })).status).toBe(201)
    expect((await api(t).post('/teacher/documents', { docType: 'experience_letter', title: 'Letter', fileId: used })).status).toBe(422) // already attached
  })

  it('replacing an identity document creates version 2 and keeps one current row (T15.4)', async () => {
    const t = await newTeacher()
    const first = await addDoc(t, 'aadhaar', { docNumber: aadhaar })
    const second = await addDoc(t, 'aadhaar', { docNumber: aadhaar })
    expect(second.body.data.version).toBe(2)
    const rows = await db.selectFrom('teacher_documents').select(['id', 'version', 'is_current']).where('teacher_id', '=', t.teacherId).where('doc_type', '=', 'aadhaar').orderBy('version').execute()
    expect(rows.map((r) => [r.version, r.is_current])).toEqual([[1, false], [2, true]])
    expect(first.body.data.id).toBe(rows[0]!.id)
    const list = (await api(t).get('/teacher/documents')).body.data.documents
    expect(list.aadhaar.id).toBe(second.body.data.id)
  })

  it('allows up to 5 certificate slots and links an education certificate to a qualification (BR-15.3)', async () => {
    const t = await newTeacher()
    const q = await api(t).post('/teacher/qualifications', { level: 'postgraduate', degree: 'M.Sc. Physics', institution: 'Bangalore University', yearCompleted: 2010 })
    const linked = await addDoc(t, 'education_certificate', { title: 'M.Sc. 2010', qualificationId: q.body.data.id })
    expect(linked.status).toBe(201)
    const qRow = await db.selectFrom('teacher_qualifications').select('document_id').where('id', '=', q.body.data.id).executeTakeFirstOrThrow()
    expect(qRow.document_id).toBe(linked.body.data.id)

    for (let i = 2; i <= 5; i++) expect((await addDoc(t, 'education_certificate', { title: `Certificate ${i}` })).status).toBe(201)
    const sixth = await addDoc(t, 'education_certificate', { title: 'Certificate 6' })
    expect(sixth.status).toBe(409)
    expect(sixth.body.error.code).toBe('LIMIT_REACHED')
    expect((await api(t).get('/teacher/documents')).body.data.documents.education_certificate).toHaveLength(5)
  })

  it('replays the same response for the same Idempotency-Key', async () => {
    const t = await newTeacher()
    const body = { docType: 'photo', fileId: await upload(t) }
    const key = randomUUID()
    const a = await api(t).post('/teacher/documents', body, key)
    const b = await api(t).post('/teacher/documents', body, key)
    expect(b.status).toBe(201)
    expect(b.body.data).toEqual(a.body.data)
    expect(await db.selectFrom('teacher_documents').select('id').where('teacher_id', '=', t.teacherId).execute()).toHaveLength(1)
  })

  it('limits document writes to 20 an hour', async () => {
    const t = await newTeacher()
    let last = 0
    for (let i = 0; i < 21; i++) last = (await api(t).post('/teacher/documents', { docType: 'photo', fileId: randomUUID() })).status
    expect(last).toBe(429)
  })

  it('is teacher-only', async () => {
    expect((await request(app).get(`${APP}/teacher/documents`).set(bearer(parent))).status).toBe(403)
    expect((await request(app).get(`${APP}/teacher/documents`)).status).toBe(401)
    expect((await request(app).post(`${APP}/teacher/registration/submit`).set(bearer(parent)).send({})).status).toBe(403)
  })
})

describe('GET /teacher/documents and DELETE', () => {
  it('reports readiness and what is missing (BR-15.6)', async () => {
    const t = await newTeacher()
    let res = await api(t).get('/teacher/documents')
    expect(res.body.data).toMatchObject({ readyToSubmit: false, missing: ['aadhaar', 'pan', 'education_certificate', 'photo'] })
    expect(res.body.data.documents.professional_certificate).toEqual([])
    await addRequiredDocs(t)
    res = await api(t).get('/teacher/documents')
    expect(res.body.data).toMatchObject({ readyToSubmit: true, missing: [] })
  })

  it('deletes only the chosen multi-slot document and flags its file (T15.5)', async () => {
    const t = await newTeacher()
    const first = await addDoc(t, 'education_certificate', { title: 'First one' })
    const second = await addDoc(t, 'education_certificate', { title: 'Second one' })
    expect((await api(t).del(`/teacher/documents/${second.body.data.id}`)).status).toBe(200)
    const docs = (await api(t).get('/teacher/documents')).body.data.documents.education_certificate
    expect(docs.map((d: { id: string }) => d.id)).toEqual([first.body.data.id])
    expect(await db.selectFrom('teacher_documents').select('id').where('id', '=', second.body.data.id).execute()).toHaveLength(0)
    const audit = await db.selectFrom('audit_logs').select('action').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_document_deleted').execute()
    expect(audit).toHaveLength(1)
  })

  it('refuses to delete identity or photo documents with 403 (T15.6)', async () => {
    const t = await newTeacher()
    for (const [type, extra] of [['aadhaar', { docNumber: aadhaar }], ['pan', { docNumber: 'ABCDE1234F' }], ['photo', {}]] as [string, Record<string, unknown>][]) {
      const d = await addDoc(t, type, extra)
      const res = await api(t).del(`/teacher/documents/${d.body.data.id}`)
      expect(res.status, type).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    }
  })

  it("404s for a missing or someone else's document", async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    const doc = await addDoc(a, 'experience_letter', { title: 'Letter' })
    expect((await api(b).del(`/teacher/documents/${doc.body.data.id}`)).status).toBe(404)
    expect((await api(a).del(`/teacher/documents/${randomUUID()}`)).status).toBe(404)
    expect((await api(a).del('/teacher/documents/not-a-uuid')).status).toBe(422)
  })

  it('closes every endpoint outside draft / reupload_requested (BR-15.1)', async () => {
    const t = await newTeacher()
    const doc = await addDoc(t, 'experience_letter', { title: 'Letter' })
    const fileId = await upload(t)
    for (const status of ['pending', 'under_review', 'approved', 'rejected']) {
      await setStatus(t.teacherId, status)
      for (const res of [await api(t).get('/teacher/documents'), await api(t).post('/teacher/documents', { docType: 'photo', fileId }), await api(t).del(`/teacher/documents/${doc.body.data.id}`)]) {
        expect(res.status, status).toBe(409)
        expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'not_editable' } })
      }
    }
  })

  it('under reupload_requested only flagged types can be replaced and nothing can be deleted (T15.9)', async () => {
    const t = await newTeacher()
    const aad = await addDoc(t, 'aadhaar', { docNumber: aadhaar })
    const letter = await addDoc(t, 'experience_letter', { title: 'Letter' })
    await setStatus(t.teacherId, 'reupload_requested')
    await db.updateTable('teacher_documents').set({ status: 'reupload_requested', review_note: 'Blurry, please retake' }).where('id', '=', aad.body.data.id).execute()

    expect((await api(t).del(`/teacher/documents/${letter.body.data.id}`)).status).toBe(409)
    const notFlagged = await addDoc(t, 'photo')
    expect(notFlagged.status).toBe(409)
    expect(notFlagged.body.error.details.reason).toBe('not_flagged')

    const list = (await api(t).get('/teacher/documents')).body.data.documents
    expect(list.aadhaar).toMatchObject({ status: 'reupload_requested', reviewNote: 'Blurry, please retake' })

    const replaced = await addDoc(t, 'aadhaar', { docNumber: aadhaar })
    expect(replaced.status).toBe(201)
    expect(replaced.body.data).toMatchObject({ version: 2, status: 'submitted' })
  })
})

describe('POST /teacher/registration/submit', () => {
  it('blocks submission while a required document is missing (T15.7)', async () => {
    const t = await newTeacher()
    await addDoc(t, 'aadhaar', { docNumber: aadhaar })
    await addDoc(t, 'pan', { docNumber: 'ABCDE1234F' })
    await addDoc(t, 'education_certificate', { title: 'B.Ed. 2010' })
    const res = await api(t).post('/teacher/registration/submit', {})
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { missing: ['photo'] } })
  })

  it('requires a captured payment of the registration fee when the fee is on', async () => {
    const t = await newTeacher()
    await addRequiredDocs(t)
    const reasonOf = (res: request.Response) => res.body.error.details.reason

    const none = await api(t).post('/teacher/registration/submit', {})
    expect(none.status).toBe(422)
    expect(reasonOf(none)).toBe('payment_required')

    const other = await newTeacher()
    const cases = [
      await capturedTxn(t.userId, { status: 'created' }),
      await capturedTxn(t.userId, { fee_code: 'PREMIUM_TEACHER', purpose: 'premium_listing' }),
      await capturedTxn(other.userId),
    ]
    for (const txn of cases) {
      const res = await api(t).post('/teacher/registration/submit', { transactionId: txn.id })
      expect(res.status).toBe(422)
      expect(reasonOf(res)).toBe('payment_required')
    }
    expect((await api(t).post('/teacher/registration/submit', { transactionId: randomUUID() })).status).toBe(422)
    expect((await api(t).post('/teacher/registration/submit', { transactionId: 'nope' })).status).toBe(422)
    expect((await db.selectFrom('teachers').select('verification_status').where('id', '=', t.teacherId).executeTakeFirstOrThrow()).verification_status).toBe('draft')
  })

  it('moves draft to pending with a log row, audit and notification, and is idempotent (T15.1, T15.11)', async () => {
    const t = await newTeacher()
    await addRequiredDocs(t)
    const txn = await capturedTxn(t.userId)
    const res = await api(t).post('/teacher/registration/submit', { transactionId: txn.id })
    expect(res.status).toBe(200)
    expect(res.body.data.verificationStatus).toBe('pending')
    expect(res.body.data.submittedAt).toBeTruthy()

    const row = await db.selectFrom('teachers').select(['verification_status', 'submitted_at', 'registration_transaction_id']).where('id', '=', t.teacherId).executeTakeFirstOrThrow()
    expect(row.verification_status).toBe('pending')
    expect(row.registration_transaction_id).toBe(txn.id)
    const logs = await db.selectFrom('teacher_verification_logs').select(['action', 'from_status', 'to_status']).where('teacher_id', '=', t.teacherId).execute()
    expect(logs).toEqual([{ action: 'submitted', from_status: 'draft', to_status: 'pending' }])
    expect(await db.selectFrom('audit_logs').select('id').where('actor_id', '=', t.userId).where('action', '=', 'app.teacher_registration_submitted').execute()).toHaveLength(1)
    const note = await db.selectFrom('user_notifications').select(['event_type', 'deep_link']).where('user_id', '=', t.userId).executeTakeFirstOrThrow()
    expect(note).toEqual({ event_type: 'teacher.registration_submitted', deep_link: 'gc://teacher/verification' })

    const again = await api(t).post('/teacher/registration/submit', { transactionId: txn.id })
    expect(again.status).toBe(200)
    expect(again.body.data.submittedAt).toBe(res.body.data.submittedAt)
    expect(await db.selectFrom('teacher_verification_logs').select('id').where('teacher_id', '=', t.teacherId).execute()).toHaveLength(1)
    expect((await api(t).get('/me')).body.data.teacher.verificationStatus).toBe('pending')
  })

  it('refuses a payment already used by another teacher', async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    await addRequiredDocs(a)
    await addRequiredDocs(b)
    const txn = await capturedTxn(a.userId)
    expect((await api(a).post('/teacher/registration/submit', { transactionId: txn.id })).status).toBe(200)
    await db.updateTable('transactions').set({ user_id: b.userId }).where('id', '=', txn.id).execute()
    expect((await api(b).post('/teacher/registration/submit', { transactionId: txn.id })).status).toBe(422)
  })

  it('answers CONFLICT_STATE for reupload_requested (resubmit lives in M16), under review and approved (T15.10)', async () => {
    const t = await newTeacher()
    await addRequiredDocs(t)
    for (const [status, reason] of [['reupload_requested', 'use_resubmit'], ['under_review', 'not_editable'], ['approved', 'not_editable']]) {
      await setStatus(t.teacherId, status!)
      const res = await api(t).post('/teacher/registration/submit', {})
      expect(res.status, status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason } })
    }
  })

  it('skips payment when the fee is switched off (T15.2)', async () => {
    const t = await newTeacher()
    await addRequiredDocs(t)
    await db.updateTable('payment_configurations').set({ is_enabled: false }).where('fee_code', '=', 'TEACHER_REGISTRATION').where('status', '=', 'active').execute()
    try {
      const res = await api(t).post('/teacher/registration/submit', {})
      expect(res.status).toBe(200)
    } finally {
      await db.updateTable('payment_configurations').set({ is_enabled: true }).where('fee_code', '=', 'TEACHER_REGISTRATION').where('status', '=', 'active').execute()
    }
    const row = await db.selectFrom('teachers').select(['verification_status', 'registration_transaction_id']).where('id', '=', t.teacherId).executeTakeFirstOrThrow()
    expect(row).toEqual({ verification_status: 'pending', registration_transaction_id: null })
  })

  it('limits submit attempts to 5 an hour', async () => {
    const t = await newTeacher()
    let last = 0
    for (let i = 0; i < 6; i++) last = (await api(t).post('/teacher/registration/submit', {})).status
    expect(last).toBe(429)
  })
})
