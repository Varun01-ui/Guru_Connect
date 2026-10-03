import { db } from '../../../db/index.js'
import type { AppTrx } from '../registration/registration.repository.js'
import type { DocType } from './docs.schemas.js'

const DOC_COLUMNS = ['d.id', 'd.doc_type', 'd.file_id', 'd.title', 'd.doc_number_masked', 'd.version', 'd.status', 'd.review_note', 'd.created_at', 'f.mime_type', 'f.bucket', 'f.object_key'] as const

export function listCurrentDocuments(teacherId: string) {
  return db
    .selectFrom('teacher_documents as d')
    .innerJoin('files as f', 'f.id', 'd.file_id')
    .select(DOC_COLUMNS)
    .where('d.teacher_id', '=', teacherId)
    .where('d.is_current', '=', true)
    .orderBy('d.created_at')
    .execute()
}

export function lockTeacherForDocs(trx: AppTrx, teacherId: string) {
  return trx
    .selectFrom('teachers')
    .select(['id', 'user_id', 'verification_status', 'submitted_at', 'registration_transaction_id'])
    .where('id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

export function findOwnUploadedFile(fileId: string, userId: string) {
  return db
    .selectFrom('files')
    .select(['id', 'mime_type', 'purpose', 'status', 'bucket', 'object_key'])
    .where('id', '=', fileId)
    .where('uploaded_by_type', '=', 'app_user')
    .where('uploaded_by_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export async function isFileLinked(fileId: string): Promise<boolean> {
  const row = await db.selectFrom('teacher_documents').select('id').where('file_id', '=', fileId).executeTakeFirst()
  return Boolean(row)
}

export function findOwnQualification(teacherId: string, qualificationId: string) {
  return db.selectFrom('teacher_qualifications').select('id').where('id', '=', qualificationId).where('teacher_id', '=', teacherId).where('deleted_at', 'is', null).executeTakeFirst()
}

export function currentOfType(trx: AppTrx, teacherId: string, docType: DocType) {
  return trx
    .selectFrom('teacher_documents')
    .select(['id', 'version', 'status', 'created_at'])
    .where('teacher_id', '=', teacherId)
    .where('doc_type', '=', docType)
    .where('is_current', '=', true)
    .orderBy('created_at')
    .execute()
}

export async function latestVersion(trx: AppTrx, teacherId: string, docType: DocType): Promise<number> {
  const row = await trx.selectFrom('teacher_documents').select((eb) => eb.fn.max('version').as('v')).where('teacher_id', '=', teacherId).where('doc_type', '=', docType).executeTakeFirst()
  return Number(row?.v ?? 0)
}

export function supersede(trx: AppTrx, documentId: string) {
  return trx.updateTable('teacher_documents').set({ is_current: false }).where('id', '=', documentId).execute()
}

export function insertDocument(
  trx: AppTrx,
  input: { teacherId: string; docType: DocType; fileId: string; title: string | null; masked: string | null; hash: string | null; version: number },
) {
  return trx
    .insertInto('teacher_documents')
    .values({
      teacher_id: input.teacherId,
      doc_type: input.docType,
      file_id: input.fileId,
      title: input.title,
      doc_number_masked: input.masked,
      doc_number_hash: input.hash,
      version: input.version,
      is_current: true,
      status: 'submitted',
    })
    .returning(['id', 'doc_type', 'status', 'doc_number_masked', 'version'])
    .executeTakeFirstOrThrow()
}

export function linkQualificationDocument(trx: AppTrx, qualificationId: string, documentId: string) {
  return trx.updateTable('teacher_qualifications').set({ document_id: documentId }).where('id', '=', qualificationId).execute()
}

export function findOwnCurrentDocument(trx: AppTrx, teacherId: string, id: string) {
  return trx
    .selectFrom('teacher_documents')
    .select(['id', 'doc_type', 'file_id', 'version'])
    .where('id', '=', id)
    .where('teacher_id', '=', teacherId)
    .where('is_current', '=', true)
    .executeTakeFirst()
}

// Nothing has been reviewed yet (draft), so the row goes away entirely and its file is marked for the cleanup job.
export async function hardDeleteDocument(trx: AppTrx, documentId: string, fileId: string) {
  await trx.deleteFrom('teacher_documents').where('id', '=', documentId).execute()
  await trx.updateTable('files').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', fileId).execute()
}

export function insertVerificationLog(trx: AppTrx, input: { teacherId: string; action: 'submitted'; fromStatus: string; toStatus: string }) {
  return trx.insertInto('teacher_verification_logs').values({ teacher_id: input.teacherId, action: input.action, from_status: input.fromStatus, to_status: input.toStatus, is_internal: false }).execute()
}

export function findTransaction(trx: AppTrx, transactionId: string) {
  return trx
    .selectFrom('transactions')
    .select(['id', 'user_id', 'purpose', 'fee_code', 'status'])
    .where('id', '=', transactionId)
    .executeTakeFirst()
}

export async function isTransactionUsedByAnotherTeacher(trx: AppTrx, transactionId: string, teacherId: string): Promise<boolean> {
  const row = await trx.selectFrom('teachers').select('id').where('registration_transaction_id', '=', transactionId).where('id', '!=', teacherId).executeTakeFirst()
  return Boolean(row)
}
