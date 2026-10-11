import type { Kysely } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'

type Executor = Kysely<DB>
export type OwnerType = 'app_user' | 'admin'

export type FileRow = {
  id: string
  bucket: string
  object_key: string
  original_name: string
  mime_type: string
  size_bytes: number | string
  visibility: 'private' | 'public'
  purpose: string
  uploaded_by_type: 'admin' | 'app_user' | 'system'
  uploaded_by_id: string | null
  status: 'pending' | 'uploaded' | 'quarantined' | 'deleted'
  created_at: Date
  deleted_at: Date | null
}

const columns = ['id', 'bucket', 'object_key', 'original_name', 'mime_type', 'size_bytes', 'visibility', 'purpose', 'uploaded_by_type', 'uploaded_by_id', 'status', 'created_at', 'deleted_at'] as const

export function insertPendingFile(
  executor: Executor,
  values: { bucket: string; objectKey: string; originalName: string; mimeType: string; sizeBytes: number; visibility: 'public' | 'private'; purpose: string; userId: string; ownerType?: OwnerType },
) {
  return executor
    .insertInto('files')
    .values({
      storage_provider: 'r2',
      bucket: values.bucket,
      object_key: values.objectKey,
      original_name: values.originalName,
      mime_type: values.mimeType,
      size_bytes: values.sizeBytes,
      visibility: values.visibility,
      purpose: values.purpose,
      uploaded_by_type: values.ownerType ?? 'app_user',
      uploaded_by_id: values.userId,
      status: 'pending',
    })
    .returning(columns)
    .executeTakeFirstOrThrow() as Promise<FileRow>
}

export async function countPendingFiles(userId: string, executor: Executor = db, ownerType: OwnerType = 'app_user'): Promise<number> {
  const row = await executor
    .selectFrom('files')
    .select(db.fn.countAll<string>().as('n'))
    .where('uploaded_by_type', '=', ownerType)
    .where('uploaded_by_id', '=', userId)
    .where('status', '=', 'pending')
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

// Scoped to the uploader: someone else's file id is indistinguishable from a missing one.
export function findOwnFile(fileId: string, userId: string, executor: Executor = db, ownerType: OwnerType = 'app_user'): Promise<FileRow | undefined> {
  return executor
    .selectFrom('files')
    .select(columns)
    .where('id', '=', fileId)
    .where('uploaded_by_type', '=', ownerType)
    .where('uploaded_by_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst() as Promise<FileRow | undefined>
}

export async function markUploaded(fileId: string, executor: Executor = db): Promise<boolean> {
  const result = await executor.updateTable('files').set({ status: 'uploaded' }).where('id', '=', fileId).where('status', '=', 'pending').executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export async function softDeleteFile(fileId: string, executor: Executor = db) {
  await executor.updateTable('files').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', fileId).where('deleted_at', 'is', null).execute()
}

export function listStalePendingFiles(before: Date, limit: number): Promise<FileRow[]> {
  return db
    .selectFrom('files')
    .select(columns)
    .where('status', '=', 'pending')
    .where('created_at', '<', before)
    .where('deleted_at', 'is', null)
    .limit(limit)
    .execute() as Promise<FileRow[]>
}

export async function deleteFileRows(ids: string[]) {
  if (ids.length === 0) return
  await db.deleteFrom('files').where('id', 'in', ids).where('status', '=', 'pending').execute()
}
