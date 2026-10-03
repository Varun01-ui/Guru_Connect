import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'

// Every function takes an optional executor so the service can run several of them in one transaction.
type Executor = Kysely<DB>

export type ChildRow = {
  id: string
  parent_id: string
  child_name: string
  class_id: string
  class_name: string
  class_level_order: number
  board_id: string | null
  board_name: string | null
  board_short_name: string | null
  preferred_mode_id: string | null
  preferred_mode_name: string | null
  school_name: string | null
  sort_order: number
  created_at: Date
  updated_at: Date
}

function childQuery(executor: Executor) {
  return executor
    .selectFrom('parent_children as c')
    .innerJoin('classes as cl', 'cl.id', 'c.class_id')
    .leftJoin('boards as b', 'b.id', 'c.board_id')
    .leftJoin('teaching_modes as m', 'm.id', 'c.preferred_mode_id')
    .select([
      'c.id',
      'c.parent_id',
      'c.child_name',
      'c.class_id',
      'cl.name as class_name',
      'cl.level_order as class_level_order',
      'c.board_id',
      'b.name as board_name',
      'b.short_name as board_short_name',
      'c.preferred_mode_id',
      'm.name as preferred_mode_name',
      'c.school_name',
      'c.sort_order',
      'c.created_at',
      'c.updated_at',
    ])
    .where('c.deleted_at', 'is', null)
}

export function listChildRows(parentId: string, executor: Executor = db): Promise<ChildRow[]> {
  return childQuery(executor).where('c.parent_id', '=', parentId).orderBy('c.sort_order').orderBy('c.created_at').execute()
}

// Not scoped to a parent on purpose: the service distinguishes "not found" (404) from "someone else's" (403).
export function findChildRow(childId: string, executor: Executor = db): Promise<ChildRow | undefined> {
  return childQuery(executor).where('c.id', '=', childId).executeTakeFirst()
}

export async function loadChildRelations(childIds: string[], executor: Executor = db) {
  if (childIds.length === 0) return { subjects: [], categories: [] }
  const [subjects, categories] = await Promise.all([
    executor
      .selectFrom('parent_child_subjects as pcs')
      .innerJoin('subjects as s', 's.id', 'pcs.subject_id')
      .select(['pcs.child_id', 's.id', 's.name', 's.min_class_order', 's.max_class_order'])
      .where('pcs.child_id', 'in', childIds)
      .orderBy('s.sort_order')
      .orderBy('s.name')
      .execute(),
    executor
      .selectFrom('parent_child_teacher_categories as pct')
      .innerJoin('teacher_categories as tc', 'tc.id', 'pct.category_id')
      .select(['pct.child_id', 'tc.id', 'tc.name'])
      .where('pct.child_id', 'in', childIds)
      .orderBy('tc.sort_order')
      .orderBy('tc.name')
      .execute(),
  ])
  return { subjects, categories }
}

export async function getParentState(parentId: string, executor: Executor = db) {
  const row = await executor.selectFrom('parents').select(['state_id']).where('id', '=', parentId).where('deleted_at', 'is', null).executeTakeFirst()
  return row?.state_id ?? null
}

// Serialises concurrent creates for one parent so the child limit can't be raced past.
export async function lockParent(parentId: string, executor: Executor) {
  await executor.selectFrom('parents').select('id').where('id', '=', parentId).forUpdate().executeTakeFirst()
}

export async function countLiveChildren(parentId: string, executor: Executor = db): Promise<number> {
  const row = await executor
    .selectFrom('parent_children')
    .select(db.fn.countAll<string>().as('n'))
    .where('parent_id', '=', parentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function nextSortOrder(parentId: string, executor: Executor): Promise<number> {
  const row = await executor
    .selectFrom('parent_children')
    .select(sql<number>`coalesce(max(sort_order), -1)`.as('max'))
    .where('parent_id', '=', parentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.max ?? -1) + 1
}

export async function insertChild(
  executor: Executor,
  values: {
    parentId: string
    childName: string
    classId: string
    boardId: string | null
    preferredModeId: string | null
    schoolName: string | null
    sortOrder: number
  },
) {
  return executor
    .insertInto('parent_children')
    .values({
      parent_id: values.parentId,
      child_name: values.childName,
      class_id: values.classId,
      board_id: values.boardId,
      preferred_mode_id: values.preferredModeId,
      school_name: values.schoolName,
      sort_order: values.sortOrder,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()
}

// Join rows are replaced wholesale (M07 §12): at most 6 / 4 rows per child, so diffing isn't worth it.
export async function replaceSubjects(executor: Executor, childId: string, subjectIds: string[]) {
  await executor.deleteFrom('parent_child_subjects').where('child_id', '=', childId).execute()
  if (subjectIds.length > 0) {
    await executor.insertInto('parent_child_subjects').values(subjectIds.map((subject_id) => ({ child_id: childId, subject_id }))).execute()
  }
}

export async function replaceCategories(executor: Executor, childId: string, categoryIds: string[]) {
  await executor.deleteFrom('parent_child_teacher_categories').where('child_id', '=', childId).execute()
  if (categoryIds.length > 0) {
    await executor.insertInto('parent_child_teacher_categories').values(categoryIds.map((category_id) => ({ child_id: childId, category_id }))).execute()
  }
}

// Optimistic-lock update: only applies if updated_at still equals the version the client sent (compared at
// millisecond precision, which is all the JSON API can express). Resolves to false on a stale write.
export async function updateChildIfVersion(
  executor: Executor,
  childId: string,
  version: Date,
  values: Partial<{
    child_name: string
    class_id: string
    board_id: string | null
    preferred_mode_id: string | null
    school_name: string | null
  }>,
): Promise<boolean> {
  const result = await executor
    .updateTable('parent_children')
    .set({ ...values, updated_at: sql`now()` })
    .where('id', '=', childId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`abs(extract(epoch from updated_at) - extract(epoch from ${version}::timestamptz)) < 0.001`)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) === 1
}

export async function softDeleteChild(executor: Executor, childId: string) {
  await executor.updateTable('parent_children').set({ deleted_at: sql`now()` }).where('id', '=', childId).where('deleted_at', 'is', null).execute()
}

export async function setSortOrder(executor: Executor, childId: string, sortOrder: number) {
  await executor.updateTable('parent_children').set({ sort_order: sortOrder }).where('id', '=', childId).execute()
}

// ---- master lookups used to validate input (active, not deleted) ----

export function findActiveClass(id: string, executor: Executor = db) {
  return executor.selectFrom('classes').select(['id', 'name', 'level_order']).where('id', '=', id).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findActiveBoard(id: string, executor: Executor = db) {
  return executor
    .selectFrom('boards')
    .select(['id', 'type', 'state_id'])
    .where('id', '=', id)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

export function findActiveMode(id: string, executor: Executor = db) {
  return executor.selectFrom('teaching_modes').select('id').where('id', '=', id).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function findActiveSubjects(ids: string[], executor: Executor = db) {
  if (ids.length === 0) return Promise.resolve([])
  return executor
    .selectFrom('subjects')
    .select(['id', 'name', 'min_class_order', 'max_class_order'])
    .where('id', 'in', ids)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .execute()
}

export function findActiveCategories(ids: string[], executor: Executor = db) {
  if (ids.length === 0) return Promise.resolve([])
  return executor.selectFrom('teacher_categories').select(['id']).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
}
