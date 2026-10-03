import { createHmac } from 'node:crypto'
import type { z } from 'zod'
import { env } from '../../../config/env.js'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { conflictState, fileTypeNotAllowed, forbidden, limitReached, notFound, rateLimited, validationFailed } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { createNotification } from '../../../lib/notify.js'
import { resolveFee } from '../../../lib/pricing.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { storage } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'
import { verhoeffValid } from '../../../lib/verhoeff.js'
import type { TeacherContext } from '../teacher/teacher.service.js'
import * as repo from './docs.repository.js'
import { IDENTITY_TYPES, MAX_SLOTS, MULTI_SLOT_TYPES, PAN_PATTERN, maskDocNumber, normaliseDocNumber } from './docs.schemas.js'
import type { DocType, createDocumentSchema } from './docs.schemas.js'

const fieldError = (path: string, message: string) => validationFailed([{ path, message }], message)

const IDENTITY_MIME = ['image/jpeg', 'image/png']
const CERTIFICATE_MIME = ['image/jpeg', 'image/png', 'application/pdf']
const REQUIRED_TYPES: DocType[] = ['aadhaar', 'pan', 'education_certificate', 'photo']
const FLAGGED = ['reupload_requested', 'rejected']

const hashDocNumber = (normalised: string) => createHmac('sha256', env.DOC_HASH_KEY).update(normalised).digest('hex')

function assertDocsOpen(status: string) {
  if (status !== 'draft' && status !== 'reupload_requested') throw conflictState('Your documents cannot be changed right now.', { reason: 'not_editable' })
}

async function throttleWrites(teacherId: string) {
  const r = await hitRateLimit(`teacher-doc-write:${teacherId}`, 20, 60 * 60 * 1000)
  if (!r.allowed) throw rateLimited(r.retryAfterSeconds)
}

type DocRow = Awaited<ReturnType<typeof repo.listCurrentDocuments>>[number]

function present(d: DocRow) {
  const isImage = d.mime_type.startsWith('image/')
  return {
    id: d.id,
    docType: d.doc_type,
    status: d.status,
    version: d.version,
    fileId: d.file_id,
    ...(d.title ? { title: d.title } : {}),
    ...(d.doc_number_masked ? { numberMasked: d.doc_number_masked } : {}),
    ...(d.review_note && FLAGGED.includes(d.status) ? { reviewNote: d.review_note } : {}),
    // Short-lived signed link for image thumbnails; identity numbers are only ever shown masked.
    ...(isImage ? { thumbnailUrl: storage.presignGet({ bucket: d.bucket as Bucket, key: d.object_key, expiresInSeconds: 60 }).url } : {}),
  }
}

function readiness(rows: DocRow[]) {
  const missing = REQUIRED_TYPES.filter((t) => !rows.some((r) => r.doc_type === t))
  return { readyToSubmit: missing.length === 0, missing }
}

// GET /teacher/documents (BR-15.1, BR-15.6)
export async function listDocuments(ctx: TeacherContext) {
  const teacher = await db.selectFrom('teachers').select('verification_status').where('id', '=', ctx.teacherId).executeTakeFirst()
  if (!teacher) throw notFound('Profile not found.')
  assertDocsOpen(teacher.verification_status)

  const rows = await repo.listCurrentDocuments(ctx.teacherId)
  const one = (type: DocType) => {
    const row = rows.find((r) => r.doc_type === type)
    return row ? present(row) : null
  }
  const many = (type: DocType) => rows.filter((r) => r.doc_type === type).map(present)
  return {
    documents: {
      aadhaar: one('aadhaar'),
      pan: one('pan'),
      education_certificate: many('education_certificate'),
      professional_certificate: many('professional_certificate'),
      experience_letter: many('experience_letter'),
      photo: one('photo'),
    },
    ...readiness(rows),
  }
}

type CreateBody = z.infer<typeof createDocumentSchema>

// POST /teacher/documents (BR-15.2, BR-15.3, BR-15.5)
export async function createDocument(ctx: TeacherContext, body: CreateBody, idempotencyKey: string | undefined) {
  const cacheKey = idempotencyKey ? `tdoc:${ctx.teacherId}:${idempotencyKey}` : null
  if (cacheKey) {
    const cached = await getIdempotent(cacheKey)
    if (cached) return cached.body as ReturnType<typeof toResponse>
  }
  await throttleWrites(ctx.teacherId)

  const docType = body.docType
  const isIdentity = IDENTITY_TYPES.includes(docType)
  const isMulti = MULTI_SLOT_TYPES.includes(docType)

  // Number: required for Aadhaar/PAN, validated, then reduced to a mask and an HMAC. The raw value goes no further.
  let masked: string | null = null
  let hash: string | null = null
  if (docType === 'aadhaar' || docType === 'pan') {
    if (!body.docNumber) throw fieldError('docNumber', docType === 'aadhaar' ? 'Enter a valid 12-digit Aadhaar number' : 'Enter a valid PAN, e.g. ABCDE1234F')
    const normalised = normaliseDocNumber(body.docNumber)
    if (docType === 'aadhaar' && !(/^\d{12}$/.test(normalised) && verhoeffValid(normalised))) throw fieldError('docNumber', 'Enter a valid 12-digit Aadhaar number')
    if (docType === 'pan' && !PAN_PATTERN.test(normalised)) throw fieldError('docNumber', 'Enter a valid PAN, e.g. ABCDE1234F')
    masked = maskDocNumber(docType, normalised)
    hash = hashDocNumber(normalised)
  }
  if (isMulti && !body.title) throw fieldError('title', 'Give this document a short title')
  if (body.qualificationId && docType !== 'education_certificate') throw fieldError('qualificationId', 'Only an education certificate can be linked to a qualification.')
  if (body.qualificationId && !(await repo.findOwnQualification(ctx.teacherId, body.qualificationId))) throw fieldError('qualificationId', 'Choose one of your qualifications.')

  // The file must be this user's confirmed teacher_document upload, of an allowed type, not already used.
  const file = await repo.findOwnUploadedFile(body.fileId, ctx.userId)
  if (!file || file.purpose !== 'teacher_document' || file.status !== 'uploaded') throw fieldError('fileId', 'Upload the file again.')
  const allowedMime = isIdentity ? IDENTITY_MIME : CERTIFICATE_MIME
  if (!allowedMime.includes(file.mime_type)) {
    throw fileTypeNotAllowed(isIdentity ? 'Choose a JPG or PNG under 10 MB' : 'Choose a JPG, PNG or PDF under 10 MB', { allowed: allowedMime })
  }
  if (await repo.isFileLinked(file.id)) throw fieldError('fileId', 'This file is already attached to a document.')

  const result = await db.transaction().execute(async (trx) => {
    const teacher = await repo.lockTeacherForDocs(trx, ctx.teacherId)
    if (!teacher) throw notFound('Profile not found.')
    assertDocsOpen(teacher.verification_status)

    const current = await repo.currentOfType(trx, ctx.teacherId, docType)
    let version = 1

    if (teacher.verification_status === 'reupload_requested') {
      // Only the flagged documents may be replaced (T15.9).
      const flagged = current.filter((c) => FLAGGED.includes(c.status))
      if (flagged.length === 0) throw conflictState('Only the documents we asked you to re-upload can be changed.', { reason: 'not_flagged' })
      const target = flagged[0]!
      await repo.supersede(trx, target.id)
      version = target.version + 1
    } else if (isIdentity) {
      for (const c of current) await repo.supersede(trx, c.id)
      version = (await repo.latestVersion(trx, ctx.teacherId, docType)) + 1
    } else if (current.length >= MAX_SLOTS) {
      throw limitReached(MAX_SLOTS, current.length, `You can add up to ${MAX_SLOTS} of these.`, 'max_documents')
    }

    const row = await repo.insertDocument(trx, { teacherId: ctx.teacherId, docType, fileId: file.id, title: body.title ?? null, masked, hash, version })
    if (body.qualificationId) await repo.linkQualificationDocument(trx, body.qualificationId, row.id)
    // Audit never carries the number or the file name.
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_document_uploaded',
      module: 'app.teacher_documents',
      entityType: 'teacher_document',
      entityId: row.id,
      newValues: { docType, version },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    return row
  })

  const response = toResponse(result)
  if (cacheKey) await putIdempotent(cacheKey, 201, response)
  return response
}

function toResponse(row: { id: string; doc_type: string; status: string; doc_number_masked: string | null; version: number }) {
  return { id: row.id, docType: row.doc_type, status: row.status, ...(row.doc_number_masked ? { numberMasked: row.doc_number_masked } : {}), version: row.version }
}

// DELETE /teacher/documents/:id (BR-15.5)
export async function deleteDocument(ctx: TeacherContext, documentId: string) {
  await db.transaction().execute(async (trx) => {
    const teacher = await repo.lockTeacherForDocs(trx, ctx.teacherId)
    if (!teacher) throw notFound('Profile not found.')
    assertDocsOpen(teacher.verification_status)
    const doc = await repo.findOwnCurrentDocument(trx, ctx.teacherId, documentId)
    if (!doc) throw notFound('This is no longer available.')
    if (IDENTITY_TYPES.includes(doc.doc_type)) throw forbidden("Upload a new one instead — this document can't be removed.")
    if (teacher.verification_status === 'reupload_requested') throw conflictState('Upload a replacement instead of deleting.', { reason: 'reupload_requested' })

    await repo.hardDeleteDocument(trx, doc.id, doc.file_id)
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_document_deleted',
      module: 'app.teacher_documents',
      entityType: 'teacher_document',
      entityId: doc.id,
      newValues: { docType: doc.doc_type, version: doc.version },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
  })
}

// POST /teacher/registration/submit (BR-15.7, BR-15.8, BR-15.9) — first submission only.
export async function submitRegistration(ctx: TeacherContext, transactionId: string | null | undefined) {
  const attempts = await hitRateLimit(`teacher-submit:${ctx.teacherId}`, 5, 60 * 60 * 1000)
  if (!attempts.allowed) throw rateLimited(attempts.retryAfterSeconds)

  const fee = await resolveFee('TEACHER_REGISTRATION')
  const feeEnabled = Boolean(fee?.is_enabled)

  return db.transaction().execute(async (trx) => {
    const teacher = await repo.lockTeacherForDocs(trx, ctx.teacherId)
    if (!teacher) throw notFound('Profile not found.')

    // A double tap after success is a no-op that reports the same state (BR-15.9).
    if (teacher.verification_status === 'pending') return { verificationStatus: 'pending' as const, submittedAt: teacher.submitted_at!.toISOString() }
    if (teacher.verification_status === 'reupload_requested') {
      throw conflictState('Use "Resend for review" to send your updated documents.', { reason: 'use_resubmit' })
    }
    if (teacher.verification_status !== 'draft') throw conflictState('Your application cannot be submitted right now.', { reason: 'not_editable' })

    const missing = readiness(await repo.listCurrentDocuments(ctx.teacherId)).missing
    if (missing.length > 0) throw validationFailed({ missing }, 'Upload all required documents before submitting.')

    if (feeEnabled) {
      const txn = transactionId ? await repo.findTransaction(trx, transactionId) : undefined
      const usable =
        txn &&
        txn.status === 'captured' &&
        txn.fee_code === 'TEACHER_REGISTRATION' &&
        txn.purpose === 'teacher_registration' &&
        txn.user_id === teacher.user_id &&
        !(await repo.isTransactionUsedByAnotherTeacher(trx, txn.id, ctx.teacherId))
      if (!usable) throw validationFailed({ reason: 'payment_required' }, 'Complete payment before submitting')
    }

    const submittedAt = new Date()
    await trx
      .updateTable('teachers')
      .set({ verification_status: 'pending', submitted_at: submittedAt, registration_transaction_id: feeEnabled ? transactionId! : null })
      .where('id', '=', ctx.teacherId)
      .execute()
    await repo.insertVerificationLog(trx, { teacherId: ctx.teacherId, action: 'submitted', fromStatus: 'draft', toStatus: 'pending' })
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_registration_submitted',
      module: 'app.teacher_documents',
      entityType: 'teacher',
      entityId: ctx.teacherId,
      newValues: { feeCode: feeEnabled ? 'TEACHER_REGISTRATION' : null, transactionId: feeEnabled ? transactionId : null, fromStatus: 'draft' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    await createNotification(trx, {
      userId: ctx.userId,
      category: 'verification',
      eventType: 'teacher.registration_submitted',
      title: 'Application submitted',
      body: "We're reviewing your documents. Most reviews finish within 24 hours.",
      deepLink: 'gc://teacher/verification',
    })
    return { verificationStatus: 'pending' as const, submittedAt: submittedAt.toISOString() }
  })
}
