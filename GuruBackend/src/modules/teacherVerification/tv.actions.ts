import type { z } from 'zod'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createNotification } from '../../lib/notify.js'
import { consoleSmsProvider } from '../../lib/providers/sms.js'
import type { AppTrx } from '../app/registration/registration.repository.js'
import { findDuplicateIdentities } from './tv.checks.js'
import type { approveTeacherSchema, createTeacherSchema, documentDecisionSchema, noteSchema, rejectTeacherSchema } from './tv.schemas.js'

export type Ctx = {
  actor: { id: string; email: string; isSuperAdmin: boolean }
  can: (permission: string) => boolean
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

const REQUIRED_MSG = 'Approve Aadhaar, PAN and at least one education certificate first.'
const DAY_MS = 86_400_000

const DOC_LABELS: Record<string, string> = { aadhaar: 'Aadhaar', pan: 'PAN', education_certificate: 'education certificate', professional_certificate: 'professional certificate', experience_letter: 'experience letter', photo: 'photo' }
const label = (docType: string) => DOC_LABELS[docType] ?? docType

const base = (ctx: Ctx, entityType: string, entityId: string) => ({ actorType: 'admin' as const, actorId: ctx.actor.id, actorEmail: ctx.actor.email, module: 'teacher_verification', entityType, entityId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId })

type TeacherRow = { id: string; user_id: string; public_code: string; full_name: string; phone: string; verification_status: string; reviewed_by: string | null; created_by: string | null; registration_transaction_id: string | null }

async function lockTeacher(trx: AppTrx, teacherId: string): Promise<TeacherRow> {
  const t = await trx
    .selectFrom('teachers')
    .select(['id', 'user_id', 'public_code', 'full_name', 'phone', 'verification_status', 'reviewed_by', 'created_by', 'registration_transaction_id'])
    .where('id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!t || t.verification_status === 'draft') throw notFound('This case no longer exists.')
  return t
}

async function adminName(trx: AppTrx, id: string | null): Promise<string> {
  if (!id) return 'Someone'
  return (await trx.selectFrom('admins').select('full_name').where('id', '=', id).executeTakeFirst())?.full_name.split(' ')[0] ?? 'Someone'
}

async function log(trx: AppTrx, ctx: Ctx, input: { teacherId: string; documentId?: string | null; action: string; fromStatus?: string | null; toStatus?: string | null; note?: string | null; isInternal: boolean; metadata?: Record<string, unknown> }) {
  await trx
    .insertInto('teacher_verification_logs')
    .values({ teacher_id: input.teacherId, document_id: input.documentId ?? null, action: input.action, from_status: input.fromStatus ?? null, to_status: input.toStatus ?? null, note: input.note ?? null, is_internal: input.isInternal, metadata: input.metadata ? (JSON.stringify(input.metadata) as never) : null, admin_id: ctx.actor.id })
    .execute()
}

// Decisions need the teacher under review and claimed by the caller; `force` (decide permission) takes the case over.
async function assertCanDecide(trx: AppTrx, ctx: Ctx, t: TeacherRow, force: boolean) {
  if (t.verification_status !== 'under_review') throw conflictState(`This teacher is ${t.verification_status.replace('_', ' ')}.`, { currentStatus: t.verification_status })
  if (t.reviewed_by === ctx.actor.id) return
  if (t.reviewed_by && !force) {
    throw conflictState(`${await adminName(trx, t.reviewed_by)} is reviewing this case. Take over?`, { claimedBy: { id: t.reviewed_by, name: await adminName(trx, t.reviewed_by) } })
  }
  if (!t.reviewed_by && !force) throw conflictState('Claim this case first.', { reason: 'not_claimed' })
  if (force && !(ctx.actor.isSuperAdmin || ctx.can('teacher_verification.decide'))) throw forbidden("You don't have permission to take over a case.")
  await takeOver(trx, ctx, t)
}

async function takeOver(trx: AppTrx, ctx: Ctx, t: TeacherRow) {
  await trx.updateTable('teachers').set({ reviewed_by: ctx.actor.id, updated_by: ctx.actor.id }).where('id', '=', t.id).execute()
  await log(trx, ctx, { teacherId: t.id, action: 'assigned', fromStatus: t.verification_status, toStatus: 'under_review', isInternal: true, metadata: { takenOverFrom: t.reviewed_by } })
  await audit(trx, { ...base(ctx, 'teacher', t.id), action: 'teacher_verification.taken_over', newValues: { from: t.reviewed_by } })
  t.reviewed_by = ctx.actor.id
}

// ---------------------------------------------------------------- claim / release (FR-16.2)

export async function claim(ctx: Ctx, teacherId: string, force: boolean) {
  await db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    if (t.verification_status !== 'pending' && t.verification_status !== 'under_review') throw conflictState(`This teacher is ${t.verification_status.replace('_', ' ')}.`, { currentStatus: t.verification_status })
    if (t.reviewed_by === ctx.actor.id && t.verification_status === 'under_review') return // already mine
    if (t.reviewed_by && t.reviewed_by !== ctx.actor.id) {
      if (!force) {
        const name = await adminName(trx, t.reviewed_by)
        throw conflictState(`${name} is reviewing this case. Take over?`, { claimedBy: { id: t.reviewed_by, name } })
      }
      if (!(ctx.actor.isSuperAdmin || ctx.can('teacher_verification.decide'))) throw forbidden("You don't have permission to take over a case.")
      await takeOver(trx, ctx, t)
      return
    }
    await trx.updateTable('teachers').set({ reviewed_by: ctx.actor.id, verification_status: 'under_review', updated_by: ctx.actor.id }).where('id', '=', teacherId).execute()
    await log(trx, ctx, { teacherId, action: 'assigned', fromStatus: t.verification_status, toStatus: 'under_review', isInternal: true })
    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher_verification.claimed', newValues: { reviewer: ctx.actor.id } })
  })
}

export async function release(ctx: Ctx, teacherId: string) {
  await db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    if (t.verification_status !== 'under_review') throw conflictState(`This teacher is ${t.verification_status.replace('_', ' ')}.`, { currentStatus: t.verification_status })
    if (t.reviewed_by !== ctx.actor.id && !(ctx.actor.isSuperAdmin || ctx.can('teacher_verification.decide'))) throw forbidden('Only the reviewer can release this case.')
    // An unclaimed case goes back to the front of the queue as pending.
    await trx.updateTable('teachers').set({ reviewed_by: null, verification_status: 'pending', updated_by: ctx.actor.id }).where('id', '=', teacherId).execute()
    await log(trx, ctx, { teacherId, action: 'assigned', fromStatus: 'under_review', toStatus: 'pending', isInternal: true, metadata: { released: true } })
    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher_verification.released', newValues: { previousReviewer: t.reviewed_by } })
  })
}

// ---------------------------------------------------------------- document decisions (FR-16.5)

type Decision = 'approve' | 'reject' | 'request-reupload'
const DOC_ACTION: Record<Decision, { status: 'approved' | 'rejected' | 'reupload_requested'; log: string; audit: string }> = {
  approve: { status: 'approved', log: 'document_approved', audit: 'teacher_document.approved' },
  reject: { status: 'rejected', log: 'document_rejected', audit: 'teacher_document.rejected' },
  'request-reupload': { status: 'reupload_requested', log: 'reupload_requested', audit: 'teacher_document.reupload_requested' },
}

export async function decideDocument(ctx: Ctx, documentId: string, decision: Decision, body: z.infer<typeof documentDecisionSchema> | null, force: boolean) {
  const cfg = DOC_ACTION[decision]
  return db.transaction().execute(async (trx) => {
    const doc = await trx.selectFrom('teacher_documents').select(['id', 'teacher_id', 'doc_type', 'version', 'is_current', 'status']).where('id', '=', documentId).forUpdate().executeTakeFirst()
    if (!doc) throw notFound('This document no longer exists.')
    const t = await lockTeacher(trx, doc.teacher_id)
    await assertCanDecide(trx, ctx, t, force)
    if (!doc.is_current) throw conflictState('A newer version of this document was uploaded.', { reason: 'not_current' })
    if (doc.status === cfg.status) throw conflictState(`This document is already ${cfg.status.replace('_', ' ')}.`, { currentStatus: doc.status })

    await trx
      .updateTable('teacher_documents')
      .set({ status: cfg.status, review_note: body?.note ?? null, reviewed_by: ctx.actor.id, reviewed_at: new Date() })
      .where('id', '=', documentId)
      .execute()
    // Visible to the teacher in their own timeline (mobile M16), hence not internal.
    await log(trx, ctx, { teacherId: t.id, documentId, action: cfg.log, note: body?.note ?? null, isInternal: false, metadata: body ? { reasonCode: body.reasonCode } : undefined })
    await audit(trx, { ...base(ctx, 'teacher_document', documentId), action: cfg.audit, newValues: { documentId, docType: doc.doc_type, ...(body ? { reasonCode: body.reasonCode } : {}) } })
    if (decision === 'approve') {
      await createNotification(trx, { userId: t.user_id, category: 'verification', eventType: 'teacher.document_approved', title: 'Document approved', body: `Your ${label(doc.doc_type)} has been approved.`, deepLink: 'gc://teacher/verification', dedupeKey: `teacher.document_approved:${documentId}` })
    }
    return { id: documentId, docType: doc.doc_type, status: cfg.status }
  })
}

// ---------------------------------------------------------------- notes (FR-16.6)

export async function addNote(ctx: Ctx, teacherId: string, body: z.infer<typeof noteSchema>) {
  await db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    await log(trx, ctx, { teacherId, action: 'note_added', note: body.note, isInternal: body.isInternal, fromStatus: t.verification_status, toStatus: t.verification_status })
    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher_verification.note_added', newValues: { isInternal: body.isInternal } })
  })
}

// ---------------------------------------------------------------- send back for re-upload (FR-16.7)

export async function sendBack(ctx: Ctx, teacherId: string, message: string, force: boolean) {
  return db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    await assertCanDecide(trx, ctx, t, force)
    const flagged = await trx.selectFrom('teacher_documents').select(['doc_type', 'status', 'review_note']).where('teacher_id', '=', teacherId).where('is_current', '=', true).where('status', 'in', ['reupload_requested', 'rejected']).execute()
    if (flagged.length === 0) throw conflictState('Mark at least one document for re-upload.', { reason: 'nothing_marked' })

    await trx.updateTable('teachers').set({ verification_status: 'reupload_requested', reviewed_by: null, updated_by: ctx.actor.id }).where('id', '=', teacherId).execute()
    await log(trx, ctx, { teacherId, action: 'reupload_requested', fromStatus: 'under_review', toStatus: 'reupload_requested', note: message, isInternal: false, metadata: { documents: flagged.map((d) => d.doc_type) } })
    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher_verification.sent_back', newValues: { documents: flagged.map((d) => d.doc_type) } })
    const list = flagged.map((d) => label(d.doc_type)).join(', ')
    await createNotification(trx, { userId: t.user_id, category: 'verification', eventType: 'teacher.reupload_requested', title: 'Action needed on your application', body: `We need a clearer copy of your ${list}. ${message}`.slice(0, 240), deepLink: 'gc://teacher/verification', dedupeKey: `teacher.reupload_requested:${teacherId}:${Date.now()}` })
    return { phone: t.phone, name: t.full_name, documents: flagged.map((d) => d.doc_type), message }
  }).then(async (r) => {
    await consoleSmsProvider.sendMessage(r.phone, `GuruConnect: we need new copies of your ${r.documents.map(label).join(', ')}. ${r.message}`).catch(() => undefined)
    return { verificationStatus: 'reupload_requested' as const, documents: r.documents }
  })
}

// ---------------------------------------------------------------- approve (FR-16.8)

type Docs = { doc_type: string; status: string }[]
export function missingRequired(docs: Docs): string[] {
  const cur = (type: string) => docs.filter((d) => d.doc_type === type)
  const missing: string[] = []
  if (!cur('aadhaar').some((d) => d.status === 'approved')) missing.push('aadhaar')
  if (!cur('pan').some((d) => d.status === 'approved')) missing.push('pan')
  if (!cur('education_certificate').some((d) => d.status === 'approved')) missing.push('education_certificate')
  if (cur('photo').length === 0) missing.push('photo')
  // optional documents that were uploaded must have been looked at
  for (const type of ['professional_certificate', 'experience_letter']) if (cur(type).some((d) => d.status === 'submitted')) missing.push(type)
  return missing
}

export async function approve(ctx: Ctx, teacherId: string, body: z.infer<typeof approveTeacherSchema>, force: boolean) {
  const result = await db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    // Maker-checker: whoever created a teacher by hand cannot approve that teacher.
    if (t.created_by === ctx.actor.id) throw forbidden('Another admin must approve a teacher you created.')
    await assertCanDecide(trx, ctx, t, force)

    const docs = (await trx.selectFrom('teacher_documents').select(['doc_type', 'status']).where('teacher_id', '=', teacherId).where('is_current', '=', true).execute()) as Docs
    const missing = missingRequired(docs)
    if (missing.length > 0) throw conflictState(REQUIRED_MSG, { missing })

    const duplicates = await findDuplicateIdentities(teacherId)
    if (duplicates.length > 0) {
      const first = duplicates[0]!
      if (!body.overrideDuplicate) throw conflictState(`This ${label(first.docType)} is already used by ${first.publicCode}.`, { duplicates })
      if (!ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can override a duplicate identity.')
      if (!body.reason) throw validationFailed([{ path: 'reason', message: 'Add a reason (10–500 characters).' }], 'Add a reason (10–500 characters).')
      await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher_verification.duplicate_overridden', newValues: { duplicates }, reason: body.reason })
    }

    const now = new Date()
    await trx
      .updateTable('teachers')
      .set({
        verification_status: 'approved',
        approved_at: now,
        reviewed_by: ctx.actor.id,
        rejected_at: null,
        rejection_reason_code: null,
        rejection_note: null,
        updated_by: ctx.actor.id,
        ...(body.grantBadge ? { is_verified_badge: true, badge_granted_at: now, badge_granted_by: ctx.actor.id } : {}),
      })
      .where('id', '=', teacherId)
      .execute()
    await log(trx, ctx, { teacherId, action: 'approved', fromStatus: 'under_review', toStatus: 'approved', note: body.note ?? null, isInternal: false })
    if (body.grantBadge) await log(trx, ctx, { teacherId, action: 'badge_granted', isInternal: false })

    // The registration period starts at approval, not payment (FR-16.8 step 3 / Module 41).
    let subscriptionId: string | null = null
    if (t.registration_transaction_id) {
      const txn = await trx.selectFrom('transactions').select(['id', 'status', 'payment_configuration_id', 'amount_paise', 'discount_paise']).where('id', '=', t.registration_transaction_id).executeTakeFirst()
      const live = await trx.selectFrom('subscriptions').select('id').where('user_id', '=', t.user_id).where('subscriber_type', '=', 'teacher').where('status', 'in', ['trial', 'active', 'grace', 'free_access']).executeTakeFirst()
      if (txn?.status === 'captured' && !live) {
        const cfg = txn.payment_configuration_id ? await trx.selectFrom('payment_configurations').select(['validity_days']).where('id', '=', txn.payment_configuration_id).executeTakeFirst() : undefined
        const sub = await trx
          .insertInto('subscriptions')
          .values({ user_id: t.user_id, subscriber_type: 'teacher', fee_code: 'TEACHER_REGISTRATION', payment_configuration_id: txn.payment_configuration_id, price_paise: Number(txn.amount_paise) + Number(txn.discount_paise), status: 'active', starts_at: now, ends_at: new Date(now.getTime() + (cfg?.validity_days ?? 365) * DAY_MS), last_transaction_id: txn.id })
          .returning('id')
          .executeTakeFirstOrThrow()
        subscriptionId = sub.id
      }
    }

    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher.approved', newValues: { grantBadge: body.grantBadge, note: body.note ?? null, subscriptionId } })
    await createNotification(trx, { userId: t.user_id, category: 'verification', eventType: 'teacher.approved', title: "You're verified! 🎉", body: 'Your GuruConnect profile is now live. Complete it to start getting leads.', deepLink: 'gc://teacher/verification', urgent: true, dedupeKey: `teacher.approved:${teacherId}` })
    return { verificationStatus: 'approved' as const, approvedAt: now.toISOString(), isVerifiedBadge: body.grantBadge, subscriptionId }
  })
  // HOOKS after commit (modules not built yet): trust score calculation (M36), search index refresh, referral event
  // `teacher.approved` for M42.
  return result
}

// ---------------------------------------------------------------- reject (FR-16.9)

export async function reject(ctx: Ctx, teacherId: string, body: z.infer<typeof rejectTeacherSchema>, force: boolean) {
  const out = await db.transaction().execute(async (trx) => {
    const t = await lockTeacher(trx, teacherId)
    await assertCanDecide(trx, ctx, t, force)
    const now = new Date()
    const forged = body.reasonCode === 'FORGED_DOCUMENT'

    await trx.updateTable('teachers').set({ verification_status: 'rejected', rejected_at: now, rejection_reason_code: body.reasonCode, rejection_note: body.note, reviewed_by: null, updated_by: ctx.actor.id }).where('id', '=', teacherId).execute()
    await log(trx, ctx, { teacherId, action: 'rejected', fromStatus: 'under_review', toStatus: 'rejected', note: body.note, isInternal: false, metadata: { reasonCode: body.reasonCode } })

    if (forged) {
      // Suspends the account everywhere (teacher row, login identity and live app sessions).
      await trx.updateTable('teachers').set({ account_status: 'suspended', suspended_at: now, suspension_reason: 'FORGED_DOCUMENT' }).where('id', '=', teacherId).execute()
      await trx.updateTable('app_users').set({ account_status: 'suspended', suspended_at: now, suspended_reason: 'FORGED_DOCUMENT' }).where('id', '=', t.user_id).execute()
      await trx.updateTable('app_sessions').set({ revoked_at: now, revoked_reason: 'account_suspended' }).where('user_id', '=', t.user_id).where('revoked_at', 'is', null).execute()
      await log(trx, ctx, { teacherId, action: 'suspended', note: 'Forged document', isInternal: true })
    }

    // A captured registration fee is refunded automatically (auto-approved request for Module 40 to process).
    let refundCreated = false
    if (t.registration_transaction_id) {
      const txn = await trx.selectFrom('transactions').select(['id', 'status', 'amount_paise']).where('id', '=', t.registration_transaction_id).executeTakeFirst()
      if (txn?.status === 'captured') {
        await trx
          .insertInto('refunds')
          .values({ transaction_id: txn.id, amount_paise: Number(txn.amount_paise), reason_code: 'teacher_rejected', reason_note: body.reasonCode, status: 'approved', requested_by_type: 'system', decided_by: ctx.actor.id, decided_at: now })
          .execute()
        refundCreated = true
      }
    }

    await audit(trx, { ...base(ctx, 'teacher', teacherId), action: 'teacher.rejected', newValues: { reasonCode: body.reasonCode, refundCreated } })
    await createNotification(trx, { userId: t.user_id, category: 'verification', eventType: 'teacher.rejected', title: 'Update on your application', body: "Your application wasn't approved this time.", deepLink: 'gc://teacher/verification', dedupeKey: `teacher.rejected:${teacherId}:${now.getTime()}` })
    return { phone: t.phone, refundCreated, reasonCode: body.reasonCode, note: body.note }
  })
  await consoleSmsProvider.sendMessage(out.phone, `GuruConnect: your teacher application wasn't approved. ${out.note}`).catch(() => undefined)
  return { verificationStatus: 'rejected' as const, reasonCode: out.reasonCode, refundCreated: out.refundCreated }
}

// ---------------------------------------------------------------- manual creation (FR-16.10)

const REQUIRED_TYPES = ['aadhaar', 'pan', 'education_certificate', 'photo']

function ageYears(dob: string): number {
  const today = new Date()
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number]
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1
  return age
}

export async function createTeacher(ctx: Ctx, body: z.infer<typeof createTeacherSchema>) {
  const errors: { path: string; message: string }[] = []
  if (Number.isNaN(Date.parse(body.dateOfBirth)) || ageYears(body.dateOfBirth) < 18 || ageYears(body.dateOfBirth) > 90) errors.push({ path: 'dateOfBirth', message: 'The teacher must be between 18 and 90 years old.' })
  if (!(await db.selectFrom('teacher_categories').select('id').where('id', '=', body.categoryId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst())) errors.push({ path: 'categoryId', message: 'Choose an active category.' })
  body.documents.forEach((d, i) => {
    if ((d.docType === 'education_certificate' || d.docType === 'professional_certificate' || d.docType === 'experience_letter') && !d.title) errors.push({ path: `documents.${i}.title`, message: 'Give this document a short title.' })
  })
  const singles = body.documents.filter((d) => ['aadhaar', 'pan', 'photo'].includes(d.docType)).map((d) => d.docType)
  if (new Set(singles).size !== singles.length) errors.push({ path: 'documents', message: 'Add only one Aadhaar, PAN and photo.' })
  if (body.submitForReview) {
    const have = new Set(body.documents.map((d) => d.docType))
    const missing = REQUIRED_TYPES.filter((r) => !have.has(r as never))
    if (missing.length) errors.push({ path: 'documents', message: `Add the required documents first: ${missing.join(', ')}.` })
  }
  if (errors.length) throw validationFailed(errors, errors[0]!.message)

  const fileIds = body.documents.map((d) => d.fileId)
  if (fileIds.length) {
    const files = await db.selectFrom('files').select('id').where('id', 'in', fileIds).where('status', '=', 'uploaded').where('deleted_at', 'is', null).execute()
    if (files.length !== new Set(fileIds).size) throw validationFailed([{ path: 'documents', message: 'One of the uploaded files was not found.' }], 'One of the uploaded files was not found.')
  }

  try {
    return await db.transaction().execute(async (trx) => {
      if (await trx.selectFrom('app_users').select('id').where('phone', '=', body.phone).where('deleted_at', 'is', null).executeTakeFirst()) throw new ApiError(409, 'CONFLICT_DUPLICATE', 'An account with this phone number already exists.')
      if (body.email && (await trx.selectFrom('app_users').select('id').where('email', '=', body.email).where('deleted_at', 'is', null).executeTakeFirst())) throw new ApiError(409, 'CONFLICT_DUPLICATE', 'An account with this email already exists.')

      const user = await trx
        .insertInto('app_users')
        .values({ user_type: 'teacher', phone: body.phone, email: body.email ?? null, full_name: body.fullName, auth_provider: 'otp', signup_source: 'admin_created' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx.insertInto('user_auth_identities').values({ user_id: user.id, provider: 'phone', provider_subject: body.phone }).execute()
      const submitted = body.submitForReview
      const teacher = await trx
        .insertInto('teachers')
        .values({
          user_id: user.id,
          full_name: body.fullName,
          phone: body.phone,
          email: body.email ?? null,
          gender: body.gender,
          date_of_birth: body.dateOfBirth,
          category_id: body.categoryId,
          highest_qualification: body.highestQualification,
          experience_years: body.experienceYears,
          verification_status: submitted ? 'pending' : 'draft',
          submitted_at: submitted ? new Date() : null,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning(['id', 'public_code'])
        .executeTakeFirstOrThrow()

      const typeCount = new Map<string, number>()
      for (const d of body.documents) {
        const n = (typeCount.get(d.docType) ?? 0) + 1
        typeCount.set(d.docType, n)
        // Only the last four characters are provided, so no duplicate-detection hash can be computed here.
        const masked = d.docNumberLast4 ? (d.docType === 'aadhaar' ? `XXXX XXXX ${d.docNumberLast4}` : d.docType === 'pan' ? `XXXXXX${d.docNumberLast4.toUpperCase()}` : null) : null
        await trx.insertInto('teacher_documents').values({ teacher_id: teacher.id, doc_type: d.docType, file_id: d.fileId, title: d.title ?? null, doc_number_masked: masked, version: 1, is_current: true, status: 'submitted' }).execute()
      }
      if (submitted) await log(trx, ctx, { teacherId: teacher.id, action: 'submitted', fromStatus: 'draft', toStatus: 'pending', note: 'Created and submitted by an admin', isInternal: false })
      await audit(trx, { ...base(ctx, 'teacher', teacher.id), action: 'teacher.created_manually', newValues: { createdBy: ctx.actor.id, submitted, documents: body.documents.length } })
      return { id: teacher.id, publicCode: teacher.public_code, userId: user.id, verificationStatus: submitted ? ('pending' as const) : ('draft' as const) }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') throw new ApiError(409, 'CONFLICT_DUPLICATE', 'An account with this phone number or email already exists.')
    throw err
  }
}

