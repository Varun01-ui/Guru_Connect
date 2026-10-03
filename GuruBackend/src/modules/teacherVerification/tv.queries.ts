import { sql } from 'kysely'
import type { z } from 'zod'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { notFound, validationFailed } from '../../lib/errors.js'
import { maskPhone } from '../../lib/present.js'
import { storage } from '../../lib/storage.js'
import type { Bucket } from '../../lib/storage.js'
import type { queueQuerySchema } from './tv.schemas.js'
import type { Ctx } from './tv.actions.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const IST_OFFSET_MS = 5.5 * HOUR_MS

// FR-16.1: green under 12 h, amber 12-24 h, red beyond.
export const slaOf = (ageHours: number): 'green' | 'amber' | 'red' => (ageHours < 12 ? 'green' : ageHours <= 24 ? 'amber' : 'red')

const istDayStart = (isoDay: string) => new Date(Date.parse(`${isoDay}T00:00:00Z`) - IST_OFFSET_MS)

// ---------------------------------------------------------------- checks summary shared by queue and case

type CheckRow = { teacher_id: string; metadata: { type?: string; result?: string; score?: number; detail?: unknown } | null; created_at: Date }

// Latest result per check type (a re-run replaces the earlier verdict).
export function latestChecks(rows: CheckRow[]) {
  const latest = new Map<string, CheckRow>()
  for (const r of rows) {
    const type = r.metadata?.type
    if (!type) continue
    const prev = latest.get(type)
    if (!prev || prev.created_at <= r.created_at) latest.set(type, r)
  }
  return [...latest.entries()].map(([type, r]) => ({ type, result: r.metadata!.result as string, score: r.metadata!.score ?? null, detail: r.metadata!.detail ?? null }))
}

const SORTABLE: Record<string, string> = { submittedAt: 't.submitted_at', fullName: 't.full_name', city: 'city_name' }

// ---------------------------------------------------------------- GET /teacher-verifications

export async function listQueue(query: z.infer<typeof queueQuerySchema>, actor: { id: string; canSeePii: boolean }) {
  const statuses = query.status?.length ? query.status : ['pending', 'under_review']
  const sorts = (query.sort ?? 'submittedAt:asc').split(',').map((s) => {
    const [field, dir] = s.split(':') as [string, 'asc' | 'desc']
    if (!SORTABLE[field]) throw validationFailed([{ path: 'sort', message: `Cannot sort by ${field}.` }], `Cannot sort by ${field}.`)
    return sql`${sql.raw(SORTABLE[field]!)} ${sql.raw(dir)} nulls last`
  })

  const now = Date.now()
  const f = [sql`t.deleted_at is null`, sql`t.verification_status = any(${statuses})`]
  if (query.sla === 'green') f.push(sql`t.submitted_at > ${new Date(now - 12 * HOUR_MS)}`)
  if (query.sla === 'amber') f.push(sql`t.submitted_at <= ${new Date(now - 12 * HOUR_MS)} and t.submitted_at >= ${new Date(now - 24 * HOUR_MS)}`)
  if (query.sla === 'red') f.push(sql`t.submitted_at < ${new Date(now - 24 * HOUR_MS)}`)
  if (query.assigned === 'me') f.push(sql`t.reviewed_by = ${actor.id}`)
  if (query.assigned === 'unassigned') f.push(sql`t.reviewed_by is null`)
  if (query.cityId) f.push(sql`exists (select 1 from teacher_locations l where l.teacher_id = t.id and l.city_id = ${query.cityId})`)
  if (query.categoryId) f.push(sql`t.category_id = ${query.categoryId}`)
  if (query.hasFailedCheck !== undefined) {
    const failed = sql`exists (select 1 from (select distinct on (metadata->>'type') metadata->>'result' as result from teacher_verification_logs where teacher_id = t.id and action = 'auto_check' order by metadata->>'type', created_at desc) x where x.result = 'fail')`
    f.push(query.hasFailedCheck ? failed : sql`not ${failed}`)
  }
  if (query.payment === 'paid') f.push(sql`exists (select 1 from transactions x where x.id = t.registration_transaction_id and x.status = 'captured')`)
  if (query.payment === 'refunded') f.push(sql`exists (select 1 from transactions x where x.id = t.registration_transaction_id and x.status in ('refund_pending','refunded','partially_refunded'))`)
  if (query.payment === 'not_required') f.push(sql`t.registration_transaction_id is null`)
  if (query.payment === 'unpaid') f.push(sql`exists (select 1 from transactions x where x.id = t.registration_transaction_id and x.status not in ('captured','refund_pending','refunded','partially_refunded'))`)
  if (query.submittedFrom) f.push(sql`t.submitted_at >= ${istDayStart(query.submittedFrom)}`)
  if (query.submittedTo) f.push(sql`t.submitted_at < ${new Date(istDayStart(query.submittedTo).getTime() + DAY_MS)}`)
  if (query.q) {
    const like = query.q.replace(/[%_\\]/g, (c) => `\\${c}`)
    const digits = query.q.replace(/\D/g, '')
    const parts = [sql`t.full_name % ${query.q}`, sql`t.full_name ilike ${`%${like}%`}`, sql`t.email ilike ${`${like}%`}`, sql`t.public_code = ${query.q.toUpperCase()}`]
    // Phone search reveals who owns a number, so it is limited to admins who may see phone numbers (section 17).
    if (actor.canSeePii && digits.length >= 10) parts.push(sql`right(t.phone, 10) = ${digits.slice(-10)}`)
    f.push(sql`(${sql.join(parts, sql` or `)})`)
  }
  const where = sql.join(f, sql` and `)

  const cityJoin = sql`left join lateral (select c.name as city_name from teacher_locations l join cities c on c.id = l.city_id where l.teacher_id = t.id order by l.is_primary desc, l.created_at limit 1) city on true`
  const rows = await sql<{ id: string; public_code: string; full_name: string; verification_status: string; submitted_at: Date; reviewed_by: string | null; registration_transaction_id: string | null; city_name: string | null; primary_subject: string | null; reviewer_name: string | null }>`
    select t.id, t.public_code, t.full_name, t.verification_status, t.submitted_at, t.reviewed_by, t.registration_transaction_id,
           city.city_name,
           (select s.name from teacher_subjects ts join subjects s on s.id = ts.subject_id where ts.teacher_id = t.id order by ts.is_primary desc, s.name limit 1) as primary_subject,
           a.full_name as reviewer_name
    from teachers t ${cityJoin} left join admins a on a.id = t.reviewed_by
    where ${where}
    order by ${sql.join([...sorts, sql`t.id`], sql`, `)}
    limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`.execute(db)
  const total = await sql<{ n: number }>`select count(*)::int as n from teachers t where ${where}`.execute(db)

  const ids = rows.rows.map((r) => r.id)
  const txnIds = rows.rows.map((r) => r.registration_transaction_id).filter((x): x is string => Boolean(x))
  const [docs, logs, txns, claims] = await Promise.all([
    ids.length ? db.selectFrom('teacher_documents').select(['teacher_id', 'status']).where('teacher_id', 'in', ids).where('is_current', '=', true).execute() : [],
    ids.length ? db.selectFrom('teacher_verification_logs').select(['teacher_id', 'metadata', 'created_at']).where('teacher_id', 'in', ids).where('action', '=', 'auto_check').execute() : [],
    txnIds.length ? db.selectFrom('transactions').select(['id', 'status']).where('id', 'in', txnIds).execute() : [],
    ids.length ? db.selectFrom('teacher_verification_logs').select(['teacher_id', 'created_at']).where('teacher_id', 'in', ids).where('action', '=', 'assigned').orderBy('created_at', 'desc').execute() : [],
  ])
  const txnStatus = new Map(txns.map((t) => [t.id, t.status]))

  const data = rows.rows.map((r) => {
    const ageHours = Math.max(0, Math.floor((now - r.submitted_at.getTime()) / HOUR_MS))
    const myDocs = docs.filter((d) => d.teacher_id === r.id)
    const checks = latestChecks(logs.filter((l) => l.teacher_id === r.id) as CheckRow[])
    const result = (type: string) => checks.find((c) => c.type === type)?.result ?? null
    const paymentRaw = r.registration_transaction_id ? txnStatus.get(r.registration_transaction_id) : null
    return {
      teacherId: r.id,
      publicCode: r.public_code,
      fullName: r.full_name,
      primarySubject: r.primary_subject,
      city: r.city_name,
      status: r.verification_status,
      submittedAt: r.submitted_at.toISOString(),
      ageHours,
      sla: slaOf(ageHours),
      assignedTo: r.reviewed_by ? { id: r.reviewed_by, name: r.reviewer_name, claimedAt: claims.find((c) => c.teacher_id === r.id)?.created_at.toISOString() ?? null } : null,
      documents: { approved: myDocs.filter((d) => d.status === 'approved').length, total: myDocs.length },
      checks: { nameMatch: result('name_match'), duplicate: result('duplicate_identity'), faceMatch: result('face_match') },
      payment: !r.registration_transaction_id ? 'not_required' : paymentRaw === 'captured' ? 'paid' : ['refund_pending', 'refunded', 'partially_refunded'].includes(paymentRaw ?? '') ? 'refunded' : 'unpaid',
    }
  })
  return { data, meta: { page: query.page, pageSize: query.pageSize, total: total.rows[0]!.n, totalPages: Math.max(1, Math.ceil(total.rows[0]!.n / query.pageSize)) } }
}

// ---------------------------------------------------------------- GET /teacher-verifications/stats

export async function queueStats() {
  const weekAgo = new Date(Date.now() - 7 * DAY_MS)
  const r = await sql<{ pending: number; under_review: number; reupload_requested: number; oldest: Date | null; over_sla: number }>`
    select count(*) filter (where verification_status = 'pending')::int as pending,
           count(*) filter (where verification_status = 'under_review')::int as under_review,
           count(*) filter (where verification_status = 'reupload_requested')::int as reupload_requested,
           min(submitted_at) filter (where verification_status in ('pending','under_review')) as oldest,
           count(*) filter (where verification_status in ('pending','under_review') and submitted_at < now() - interval '24 hours')::int as over_sla
    from teachers where deleted_at is null`.execute(db)
  const decisions = await sql<{ approved: number; rejected: number; avg_hours: number | null }>`
    select count(*) filter (where l.action = 'approved')::int as approved,
           count(*) filter (where l.action = 'rejected')::int as rejected,
           avg(extract(epoch from (l.created_at - t.submitted_at)) / 3600) filter (where t.submitted_at is not null) as avg_hours
    from teacher_verification_logs l join teachers t on t.id = l.teacher_id
    where l.action in ('approved','rejected') and l.created_at >= ${weekAgo}`.execute(db)
  const row = r.rows[0]!
  const d = decisions.rows[0]!
  return {
    pending: row.pending,
    underReview: row.under_review,
    reuploadRequested: row.reupload_requested,
    inQueue: row.pending + row.under_review,
    overSla: row.over_sla,
    oldestAgeHours: row.oldest ? Math.floor((Date.now() - row.oldest.getTime()) / HOUR_MS) : null,
    decisionsThisWeek: { approved: d.approved, rejected: d.rejected },
    avgReviewHours: d.avg_hours === null ? null : Math.round(Number(d.avg_hours) * 10) / 10,
  }
}

// ---------------------------------------------------------------- GET /teacher-verifications/:teacherId

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|')
    return at && id && !Number.isNaN(Date.parse(at)) ? { at: new Date(at), id } : null
  } catch {
    return null
  }
}

const signedThumb = (d: { mime_type: string; bucket: string; object_key: string }) =>
  d.mime_type.startsWith('image/') ? storage.presignGet({ bucket: d.bucket as Bucket, key: d.object_key, expiresInSeconds: 60 }).url : null

export async function getCase(teacherId: string, actor: { canSeePii: boolean }, cursor?: string) {
  const t = await db
    .selectFrom('teachers as t')
    .leftJoin('teacher_categories as c', 'c.id', 't.category_id')
    .leftJoin('admins as a', 'a.id', 't.reviewed_by')
    .select(['t.id', 't.public_code', 't.full_name', 't.gender', 't.email', 't.phone', 't.highest_qualification', 't.experience_years', 't.verification_status', 't.submitted_at', 't.reviewed_by', 't.registration_transaction_id', 't.created_by', 't.is_verified_badge', 'c.name as category', 'a.full_name as reviewer_name'])
    .select((eb) => eb.cast<string | null>(eb.ref('t.date_of_birth'), 'text').as('dob'))
    .where('t.id', '=', teacherId)
    .where('t.deleted_at', 'is', null)
    .executeTakeFirst()
  if (!t || t.verification_status === 'draft') throw notFound('This case no longer exists.')

  const [docs, subjects, city, txn, claimLog, duplicates] = await Promise.all([
    db
      .selectFrom('teacher_documents as d')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .leftJoin('admins as a', 'a.id', 'd.reviewed_by')
      .select(['d.id', 'd.doc_type', 'd.title', 'd.doc_number_masked', 'd.version', 'd.is_current', 'd.status', 'd.review_note', 'd.reviewed_at', 'd.created_at', 'f.mime_type', 'f.bucket', 'f.object_key', 'a.full_name as reviewer'])
      .where('d.teacher_id', '=', teacherId)
      .orderBy('d.doc_type')
      .orderBy('d.version', 'desc')
      .orderBy('d.created_at', 'desc')
      .execute(),
    db.selectFrom('teacher_subjects as ts').innerJoin('subjects as s', 's.id', 'ts.subject_id').select('s.name').where('ts.teacher_id', '=', teacherId).orderBy('ts.is_primary', 'desc').orderBy('s.name').execute(),
    db.selectFrom('teacher_locations as l').innerJoin('cities as c', 'c.id', 'l.city_id').select('c.name').where('l.teacher_id', '=', teacherId).orderBy('l.is_primary', 'desc').executeTakeFirst(),
    t.registration_transaction_id ? db.selectFrom('transactions').select(['public_code', 'amount_paise', 'status']).where('id', '=', t.registration_transaction_id).executeTakeFirst() : Promise.resolve(undefined),
    db.selectFrom('teacher_verification_logs').select('created_at').where('teacher_id', '=', teacherId).where('action', '=', 'assigned').orderBy('created_at', 'desc').executeTakeFirst(),
    import('./tv.checks.js').then((m) => m.findDuplicateIdentities(teacherId)),
  ])

  const current = docs.filter((d) => d.is_current)
  const documents = current.map((d) => ({
    id: d.id,
    docType: d.doc_type,
    ...(d.title ? { title: d.title } : {}),
    version: d.version,
    isCurrent: true,
    status: d.status,
    numberMasked: d.doc_number_masked,
    thumbnailUrl: signedThumb(d),
    reviewedBy: d.reviewer,
    reviewNote: d.review_note,
    submittedAt: d.created_at.toISOString(),
    previousVersions: docs.filter((p) => !p.is_current && p.doc_type === d.doc_type && p.version < d.version && (d.doc_type === 'education_certificate' || d.doc_type === 'professional_certificate' || d.doc_type === 'experience_letter' ? p.title === d.title : true)).map((p) => ({ id: p.id, version: p.version, status: p.status, reviewNote: p.review_note })),
  }))

  const limit = 50
  const decoded = cursor ? decodeCursor(cursor) : null
  let logQuery = db
    .selectFrom('teacher_verification_logs as l')
    .leftJoin('admins as a', 'a.id', 'l.admin_id')
    .select(['l.id', 'l.action', 'l.created_at', 'l.note', 'l.is_internal', 'l.from_status', 'l.to_status', 'l.document_id', 'l.metadata', 'a.full_name as admin_name'])
    .where('l.teacher_id', '=', teacherId)
    .where('l.action', '<>', 'auto_check')
    .orderBy('l.created_at', 'desc')
    .orderBy('l.id', 'desc')
    .limit(limit + 1)
  if (decoded) logQuery = logQuery.where(sql<boolean>`(l.created_at, l.id) < (${decoded.at}, ${decoded.id}::uuid)`)
  const logRows = await logQuery.execute()
  const page = logRows.slice(0, limit)
  const checkLogs = await db.selectFrom('teacher_verification_logs').select(['teacher_id', 'metadata', 'created_at']).where('teacher_id', '=', teacherId).where('action', '=', 'auto_check').execute()

  return {
    teacher: {
      id: t.id,
      publicCode: t.public_code,
      fullName: t.full_name,
      gender: t.gender,
      dateOfBirth: t.dob,
      phoneMasked: maskPhone(t.phone),
      ...(actor.canSeePii ? { phone: t.phone } : {}),
      email: t.email,
      category: t.category,
      highestQualification: t.highest_qualification,
      experienceYears: t.experience_years,
      subjects: subjects.map((s) => s.name),
      city: city?.name ?? null,
      status: t.verification_status,
      submittedAt: t.submitted_at?.toISOString() ?? null,
      isVerifiedBadge: t.is_verified_badge,
      createdByAdmin: Boolean(t.created_by),
      assignedTo: t.reviewed_by ? { id: t.reviewed_by, name: t.reviewer_name, claimedAt: claimLog?.created_at.toISOString() ?? null } : null,
    },
    documents,
    checks: latestChecks(checkLogs as CheckRow[]),
    timeline: page
      .map((l) => ({ id: l.id, action: l.action, at: l.created_at.toISOString(), by: l.admin_name ?? (['submitted', 'resubmitted'].includes(l.action) ? 'teacher' : 'system'), note: l.note, isInternal: l.is_internal, fromStatus: l.from_status, toStatus: l.to_status, documentId: l.document_id }))
      .reverse(),
    timelineNextCursor: logRows.length > limit ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null,
    payment: txn ? { transactionCode: txn.public_code, amountPaise: Number(txn.amount_paise), status: txn.status } : null,
    duplicates,
  }
}

// ---------------------------------------------------------------- GET /teacher-documents/:documentId/file

// Original files are only reachable through an audited, 60-second signed URL (section 22).
export async function getDocumentFile(ctx: Ctx, documentId: string) {
  const doc = await db
    .selectFrom('teacher_documents as d')
    .innerJoin('files as f', 'f.id', 'd.file_id')
    .select(['d.id', 'd.teacher_id', 'd.doc_type', 'f.bucket', 'f.object_key', 'f.mime_type'])
    .where('d.id', '=', documentId)
    .executeTakeFirst()
  if (!doc) throw notFound('This document no longer exists.')
  const signed = storage.presignGet({ bucket: doc.bucket as Bucket, key: doc.object_key, expiresInSeconds: 60 })
  await audit(db, { actorType: 'admin', actorId: ctx.actor.id, actorEmail: ctx.actor.email, action: 'teacher_document.unmasked', module: 'teacher_verification', entityType: 'teacher_document', entityId: doc.id, newValues: { documentId: doc.id, docType: doc.doc_type, teacherId: doc.teacher_id }, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId })
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString(), mimeType: doc.mime_type }
}
