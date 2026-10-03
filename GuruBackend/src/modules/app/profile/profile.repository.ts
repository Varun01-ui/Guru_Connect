import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'

type Executor = Kysely<DB>

export function findParentProfile(parentId: string, executor: Executor = db) {
  return executor
    .selectFrom('parents as p')
    .innerJoin('app_users as u', 'u.id', 'p.user_id')
    .leftJoin('cities as c', 'c.id', 'p.city_id')
    .leftJoin('areas as a', 'a.id', 'p.area_id')
    .leftJoin('files as f', (join) => join.onRef('f.id', '=', 'u.profile_photo_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select([
      'p.id',
      'p.user_id',
      'p.public_code',
      'p.full_name',
      'p.state_id',
      'p.city_id',
      'p.area_id',
      'p.created_at',
      'p.updated_at',
      'u.phone as user_phone',
      'u.email as user_email',
      'u.profile_photo_file_id',
      'c.name as city_name',
      'a.name as area_name',
      'f.object_key as photo_key',
    ])
    .where('p.id', '=', parentId)
    .where('p.deleted_at', 'is', null)
    .executeTakeFirst()
}

export async function countChildren(parentId: string) {
  const row = await db
    .selectFrom('parent_children')
    .select(db.fn.countAll<string>().as('n'))
    .where('parent_id', '=', parentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function countUnreadNotifications(userId: string) {
  const row = await db
    .selectFrom('user_notifications')
    .select(db.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export function findActiveCity(id: string, executor: Executor = db) {
  return executor.selectFrom('cities').select(['id', 'name', 'state_id']).where('id', '=', id).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findActiveAreaInCity(areaId: string, cityId: string, executor: Executor = db) {
  return executor
    .selectFrom('areas')
    .select(['id', 'name'])
    .where('id', '=', areaId)
    .where('city_id', '=', cityId)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

// Optimistic-lock update on the parents row (same ms-precision comparison as parent_children).
export async function updateParentIfVersion(
  executor: Executor,
  parentId: string,
  version: Date,
  values: Partial<{ full_name: string; state_id: string | null; city_id: string | null; area_id: string | null }>,
): Promise<boolean> {
  const result = await executor
    .updateTable('parents')
    .set({ ...values, updated_at: sql`now()` })
    .where('id', '=', parentId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`abs(extract(epoch from updated_at) - extract(epoch from ${version}::timestamptz)) < 0.001`)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

// The avatar must be a verified, public, undeleted 'avatar' upload made by this same user.
export function findOwnAvatarFile(fileId: string, userId: string, executor: Executor = db) {
  return executor
    .selectFrom('files')
    .select(['id', 'bucket', 'object_key'])
    .where('id', '=', fileId)
    .where('uploaded_by_type', '=', 'app_user')
    .where('uploaded_by_id', '=', userId)
    .where('purpose', '=', 'avatar')
    .where('visibility', '=', 'public')
    .where('status', '=', 'uploaded')
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

// Shared avatar column (M00): shown in /me and the app header for every role, so it lives on app_users.
export async function updateUserPhoto(executor: Executor, userId: string, fileId: string | null) {
  await executor.updateTable('app_users').set({ profile_photo_file_id: fileId }).where('id', '=', userId).execute()
}

export function findFileLocation(fileId: string, executor: Executor = db) {
  return executor.selectFrom('files').select(['id', 'bucket', 'object_key']).where('id', '=', fileId).executeTakeFirst()
}

// app_users.full_name is the display name shown in /me and the app header; keep it in step with the parent profile.
export async function updateUserFullName(executor: Executor, userId: string, fullName: string) {
  await executor.updateTable('app_users').set({ full_name: fullName }).where('id', '=', userId).execute()
}
