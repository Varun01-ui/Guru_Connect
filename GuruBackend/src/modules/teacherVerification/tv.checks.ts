import { db } from '../../db/index.js'

// FR-16.4: automated checks only ever inform the reviewer; they never approve or reject on their own.
export type CheckType = 'name_match' | 'duplicate_identity' | 'face_match' | 'age' | 'image_quality'
export type CheckResult = 'pass' | 'warn' | 'fail'
export type CheckOutcome = { type: CheckType; result: CheckResult; score?: number; detail?: Record<string, unknown> }

// Vendor integrations (OCR, face match, image analysis) sit behind this interface so vendors can change. No vendor is
// contracted yet, so the development implementation returns null ("not run") for every check that needs one.
export interface IdentityChecks {
  nameMatch(input: { applicationName: string; aadhaarFileId: string | null; panFileId: string | null }): Promise<{ score: number } | null>
  faceMatch(input: { photoFileId: string | null; aadhaarFileId: string | null }): Promise<{ score: number } | null>
  imageQuality(input: { fileIds: string[] }): Promise<{ shortSidePx: number; blank: boolean }[] | null>
}

export const devIdentityChecks: IdentityChecks = {
  async nameMatch() {
    return null
  },
  async faceMatch() {
    return null
  },
  async imageQuality() {
    return null
  },
}

// Token-set ratio between two names, 0..1 (case, punctuation and word order do not matter).
export function nameSimilarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean))
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const shared = [...ta].filter((t) => tb.has(t)).length
  // Dice-style: rewards overlap, penalises extra words on either side only mildly
  return (2 * shared) / (ta.size + tb.size)
}

export const nameMatchResult = (score: number): CheckResult => (score >= 0.85 ? 'pass' : score >= 0.6 ? 'warn' : 'fail')
export const faceMatchResult = (score: number): CheckResult | 'fail' => (score >= 0.9 ? 'pass' : score >= 0.75 ? 'warn' : 'fail')

function ageOn(dob: string, today = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number]
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1
  return age
}

// Other teachers' current Aadhaar/PAN carrying the same number hash (FR-16.4 "Duplicate identity").
export async function findDuplicateIdentities(teacherId: string) {
  const own = await db
    .selectFrom('teacher_documents')
    .select(['doc_type', 'doc_number_hash'])
    .where('teacher_id', '=', teacherId)
    .where('is_current', '=', true)
    .where('doc_type', 'in', ['aadhaar', 'pan'])
    .where('doc_number_hash', 'is not', null)
    .execute()
  const found: { teacherId: string; publicCode: string; docType: 'aadhaar' | 'pan' }[] = []
  for (const doc of own) {
    const rows = await db
      .selectFrom('teacher_documents as d')
      .innerJoin('teachers as t', 't.id', 'd.teacher_id')
      .select(['t.id', 't.public_code'])
      .where('d.doc_type', '=', doc.doc_type)
      .where('d.doc_number_hash', '=', doc.doc_number_hash!)
      .where('d.is_current', '=', true)
      .where('d.teacher_id', '<>', teacherId)
      .where('t.deleted_at', 'is', null)
      .execute()
    for (const r of rows) found.push({ teacherId: r.id, publicCode: r.public_code, docType: doc.doc_type as 'aadhaar' | 'pan' })
  }
  return found
}

export async function runChecks(teacherId: string, checks: IdentityChecks = devIdentityChecks): Promise<CheckOutcome[]> {
  const teacher = await db.selectFrom('teachers').select(['full_name']).select((eb) => eb.cast<string | null>(eb.ref('date_of_birth'), 'text').as('dob')).where('id', '=', teacherId).executeTakeFirstOrThrow()
  const docs = await db.selectFrom('teacher_documents').select(['doc_type', 'file_id']).where('teacher_id', '=', teacherId).where('is_current', '=', true).execute()
  const fileOf = (type: string) => docs.find((d) => d.doc_type === type)?.file_id ?? null
  const out: CheckOutcome[] = []

  const duplicates = await findDuplicateIdentities(teacherId)
  out.push({ type: 'duplicate_identity', result: duplicates.length ? 'fail' : 'pass', detail: duplicates.length ? { duplicates } : undefined })

  if (teacher.dob) out.push({ type: 'age', result: ageOn(teacher.dob) >= 18 ? 'pass' : 'fail' })

  const name = await checks.nameMatch({ applicationName: teacher.full_name, aadhaarFileId: fileOf('aadhaar'), panFileId: fileOf('pan') })
  if (name) out.push({ type: 'name_match', result: nameMatchResult(name.score), score: name.score })
  const face = await checks.faceMatch({ photoFileId: fileOf('photo'), aadhaarFileId: fileOf('aadhaar') })
  if (face) out.push({ type: 'face_match', result: faceMatchResult(face.score), score: face.score })
  const quality = await checks.imageQuality({ fileIds: docs.map((d) => d.file_id) })
  if (quality) out.push({ type: 'image_quality', result: quality.some((q) => q.blank || q.shortSidePx < 800) ? 'warn' : 'pass' })
  return out
}
