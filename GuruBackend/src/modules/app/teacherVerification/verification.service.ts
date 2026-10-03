import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { conflictState, notFound, validationFailed } from '../../../lib/errors.js'
import { createNotification } from '../../../lib/notify.js'
import type { TeacherContext } from '../teacher/teacher.service.js'

const DAY_MS = 86_400_000
const FLAGGED = ['reupload_requested', 'rejected']

const DOC_LABELS: Record<string, string> = {
  aadhaar: 'Aadhaar',
  pan: 'PAN',
  education_certificate: 'Education certificate',
  professional_certificate: 'Professional certificate',
  experience_letter: 'Experience letter',
  photo: 'Photo',
}

// BR-16.1: six internal states, four things a teacher actually needs to see.
export function displayStatus(status: string): 'pending' | 'approved' | 'rejected' | 'reupload_required' | null {
  switch (status) {
    case 'pending':
    case 'under_review':
      return 'pending'
    case 'reupload_requested':
      return 'reupload_required'
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    default:
      return null // draft: the screen is not reachable yet
  }
}

// BR-16.6: teacher-safe copy per rejection reason. Only the codes named in the schema comments have wording.
const REJECTION_COPY: Record<string, string> = {
  NAME_MISMATCH: "The name on your documents didn't match.",
  DOC_UNREADABLE: "We couldn't read your documents clearly.",
  FORGED_DOCUMENT: "We couldn't verify your documents.",
}
const rejectionCopy = (code: string | null) => (code && REJECTION_COPY[code]) || "Your application wasn't approved this time."

// Surfaced in the timeline (BR-16.4); everything else (assigned, note_added, auto_check, ...) is never returned.
const TIMELINE_ACTIONS = ['submitted', 'resubmitted', 'document_approved', 'document_rejected', 'reupload_requested', 'approved', 'rejected', 'badge_granted']

type DocRow = { id: string; doc_type: string; status: string; version: number; review_note: string | null }

async function currentDocs(teacherId: string): Promise<DocRow[]> {
  return db.selectFrom('teacher_documents').select(['id', 'doc_type', 'status', 'version', 'review_note']).where('teacher_id', '=', teacherId).where('is_current', '=', true).orderBy('created_at').execute() as Promise<DocRow[]>
}

// A current, submitted document whose previous version was flagged has been replaced (BR-16.7 / M15 uploads).
async function replacedDocTypes(teacherId: string, docs: DocRow[]): Promise<Set<string>> {
  const replaced = new Set<string>()
  for (const d of docs) {
    if (d.status !== 'submitted' || d.version < 2) continue
    const prev = await db
      .selectFrom('teacher_documents')
      .select('status')
      .where('teacher_id', '=', teacherId)
      .where('doc_type', '=', d.doc_type as 'aadhaar')
      .where('is_current', '=', false)
      .where('status', 'in', FLAGGED as never[])
      .where('version', '<', d.version)
      .executeTakeFirst()
    if (prev) replaced.add(d.id)
  }
  return replaced
}

export async function getVerification(teacherId: string) {
  const t = await db
    .selectFrom('teachers')
    .select(['verification_status', 'submitted_at', 'is_verified_badge', 'profile_completeness', 'rejected_at', 'rejection_reason_code', 'rejection_note'])
    .where('id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!t) throw notFound('Profile not found.')
  const display = displayStatus(t.verification_status)
  if (!display) throw notFound('Submit your application first.')

  const docs = await currentDocs(teacherId)
  const replaced = await replacedDocTypes(teacherId, docs)
  const pending = docs.filter((d) => FLAGGED.includes(d.status)).map((d) => d.doc_type)

  // Internal rows are filtered in SQL, never by the client (BR-16.3).
  const logs = await db
    .selectFrom('teacher_verification_logs as l')
    .leftJoin('teacher_documents as d', 'd.id', 'l.document_id')
    .select(['l.action', 'l.created_at', 'l.note', 'l.document_id', 'd.doc_type'])
    .where('l.teacher_id', '=', teacherId)
    .where('l.is_internal', '=', false)
    .where('l.action', 'in', TIMELINE_ACTIONS)
    .orderBy('l.created_at', 'desc')
    .limit(20)
    .execute()

  const timeline = logs
    .reverse()
    .filter((l) => l.action !== 'badge_granted' || t.is_verified_badge)
    .map((l) => {
      const doc = l.doc_type ? DOC_LABELS[l.doc_type] ?? l.doc_type : null
      const labels: Record<string, string> = {
        submitted: 'Application submitted',
        resubmitted: 'Re-submitted',
        document_approved: `${doc ?? 'Document'} approved`,
        document_rejected: `${doc ?? 'Document'} needs changes`,
        reupload_requested: `${doc ?? 'Document'} needs changes`,
        approved: 'Application approved',
        rejected: 'Application rejected',
        badge_granted: 'Verified badge granted',
      }
      return {
        at: l.created_at.toISOString(),
        event: l.action,
        label: labels[l.action]!,
        ...(l.doc_type ? { docType: l.doc_type } : {}),
        ...(l.action === 'rejected' ? { reason: rejectionCopy(t.rejection_reason_code) } : {}),
      }
    })

  const base = {
    verificationStatus: t.verification_status,
    displayStatus: display,
    submittedAt: t.submitted_at?.toISOString() ?? null,
    isVerifiedBadge: t.is_verified_badge,
    documents: docs.map((d) => ({
      docType: d.doc_type,
      status: d.status,
      ...(FLAGGED.includes(d.status) && d.review_note ? { reviewNote: d.review_note } : {}),
      ...(FLAGGED.includes(d.status) ? { replaced: false } : replaced.has(d.id) ? { replaced: true } : {}),
    })),
    canResubmit: t.verification_status === 'reupload_requested' && pending.length === 0,
    timeline,
  }

  if (display === 'approved') return { ...base, profileCompleteness: t.profile_completeness }
  if (display === 'rejected') {
    const rejectedAt = t.rejected_at
    const canReapplyAt = rejectedAt ? new Date(rejectedAt.getTime() + 30 * DAY_MS) : null
    return {
      ...base,
      rejectionReasonCode: t.rejection_reason_code,
      rejectionMessage: rejectionCopy(t.rejection_reason_code),
      rejectionNote: t.rejection_note,
      rejectedAt: rejectedAt?.toISOString() ?? null,
      canReapplyAt: canReapplyAt?.toISOString() ?? null,
      reapplyBlocked: t.rejection_reason_code === 'FORGED_DOCUMENT',
    }
  }
  return base
}

// POST /teacher/verification/resubmit (BR-16.7): reupload_requested -> pending. submitted_at is left alone so the
// admin SLA clock keeps running (Admin FR-16.7).
export async function resubmit(ctx: TeacherContext) {
  return db.transaction().execute(async (trx) => {
    const t = await trx.selectFrom('teachers').select(['verification_status', 'submitted_at']).where('id', '=', ctx.teacherId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst()
    if (!t) throw notFound('Profile not found.')
    if (t.verification_status !== 'reupload_requested') throw conflictState('Your application is not waiting for documents.', { reason: 'not_reupload_requested' })

    const docs = (await trx.selectFrom('teacher_documents').select(['id', 'doc_type', 'status', 'version', 'review_note']).where('teacher_id', '=', ctx.teacherId).where('is_current', '=', true).execute()) as DocRow[]
    const pending = docs.filter((d) => FLAGGED.includes(d.status)).map((d) => d.doc_type)
    if (pending.length > 0) throw validationFailed({ pending }, 'Upload the remaining documents first.')
    const replaced = [...(await replacedDocTypes(ctx.teacherId, docs))].map((id) => docs.find((d) => d.id === id)!.doc_type)

    await trx.updateTable('teachers').set({ verification_status: 'pending' }).where('id', '=', ctx.teacherId).execute()
    // Visible to the teacher in their own timeline, hence not internal.
    await trx.insertInto('teacher_verification_logs').values({ teacher_id: ctx.teacherId, action: 'resubmitted', from_status: 'reupload_requested', to_status: 'pending', is_internal: false }).execute()
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_verification_resubmitted',
      module: 'app.teacher_verification',
      entityType: 'teacher',
      entityId: ctx.teacherId,
      newValues: { fromStatus: 'reupload_requested', documentsReplaced: replaced },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    await createNotification(trx, {
      userId: ctx.userId,
      category: 'verification',
      eventType: 'teacher.verification_resubmitted',
      title: 'Sent back for review',
      body: "We're reviewing your updated documents. Most reviews finish within 24 hours.",
      deepLink: 'gc://teacher/verification',
    })
    return { verificationStatus: 'pending' as const, displayStatus: 'pending' as const, submittedAt: t.submitted_at?.toISOString() ?? null }
  })
}
