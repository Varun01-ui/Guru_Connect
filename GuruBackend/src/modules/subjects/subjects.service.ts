import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { foreignKeysTo } from '../../lib/masters/references.js'
import { cdnUrl } from '../../lib/present.js'
import { slugify } from '../../lib/slug.js'
import { MAX_ALIASES, MAX_TRENDING } from './subjects.schemas.js'
import type { CreateSubjectInput, DropdownField, ListQuery, PatchSubjectInput } from './subjects.schemas.js'

export type { Ctx }

const COLUMNS = [
  'subjects.id',
  'subjects.name',
  'subjects.slug',
  'subjects.category',
  'subjects.parent_subject_id',
  'subjects.aliases',
  'subjects.icon_file_id',
  'subjects.min_class_order',
  'subjects.max_class_order',
  'subjects.is_trending',
  'subjects.is_active',
  'subjects.sort_order',
  'subjects.created_at',
  'subjects.updated_at',
  'subjects.deleted_at',
] as const
const teacherCount = sql<number>`(select count(distinct ts.teacher_id)::int from teacher_subjects ts join teachers t on t.id = ts.teacher_id and t.deleted_at is null where ts.subject_id = subjects.id)`.as('teacher_count')

const NOT_FOUND = 'Subject not found.'
const BAD_PARENT = 'Pick an active parent record.'
const BAD_ICON = 'Pick an uploaded subject icon.'
const BAD_LEVEL = 'Pick a class level from the list.'
const TRENDING_FULL = `Up to ${MAX_TRENDING} subjects can be trending.`
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('subjects')

type Row = {
  id: string
  name: string
  slug: string
  category: 'academic' | 'competitive_exam' | 'language' | 'music_arts' | 'coding_skills' | 'other'
  parent_subject_id: string | null
  parent_name: string | null
  aliases: string[]
  icon_file_id: string | null
  icon_key: string | null
  min_class_order: number | null
  max_class_order: number | null
  is_trending: boolean
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  teacher_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    category: r.category,
    parent: r.parent_subject_id ? { id: r.parent_subject_id, name: r.parent_name! } : null,
    parentSubjectId: r.parent_subject_id,
    aliases: r.aliases,
    classRange: { min: r.min_class_order, max: r.max_class_order },
    minClassOrder: r.min_class_order,
    maxClassOrder: r.max_class_order,
    isTrending: r.is_trending,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    teacherCount: r.teacher_count,
    iconFileId: r.icon_file_id,
    iconUrl: cdnUrl(r.icon_key),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type SubjectView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  return duplicateError('A subject with this name already exists.', 'name')
}

// "Vedic Maths" -> "vedic-maths", then "vedic-maths-2" when another live subject has it. The slug is fixed at creation.
async function freeSlug(executor: Kysely<DB>, name: string): Promise<string> {
  const base = /[a-z0-9]/i.test(name.normalize('NFKD')) ? slugify(name).slice(0, 56) : 'subject'
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const taken = await executor.selectFrom('subjects').select('id').where('slug', '=', candidate).where('deleted_at', 'is', null).executeTakeFirst()
    if (!taken) return candidate
  }
}

async function assertIcon(executor: Kysely<DB>, fileId: string | null) {
  if (fileId === null) return
  const file = await executor
    .selectFrom('files')
    .select('id')
    .where('id', '=', fileId)
    .where('purpose', '=', 'subject_icon')
    .where('status', '=', 'uploaded')
    .where('visibility', '=', 'public')
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!file) throw validationFailed([{ path: 'iconFileId', message: BAD_ICON }], BAD_ICON)
}

// Max depth is 2 (a subject, or a subject under a root), no subject is its own parent, and the parent must be live and
// active (section 5).
async function assertParent(executor: Kysely<DB>, subjectId: string | null, parentId: string) {
  const fail = (message: string) => validationFailed([{ path: 'parentSubjectId', message }], message)
  if (parentId === subjectId) throw fail("A subject can't be its own parent.")
  const parent = await executor.selectFrom('subjects').select(['id', 'is_active', 'parent_subject_id']).where('id', '=', parentId).where('deleted_at', 'is', null).executeTakeFirst()
  if (!parent || !parent.is_active) throw fail(BAD_PARENT)
  if (subjectId && parent.parent_subject_id === subjectId) throw fail("A subject can't be its own parent.") // picking its own child
  if (parent.parent_subject_id) throw fail('A subject can have at most two levels: pick a main subject as the parent.')
  if (subjectId) {
    const child = await executor.selectFrom('subjects').select('id').where('parent_subject_id', '=', subjectId).where('deleted_at', 'is', null).executeTakeFirst()
    if (child) throw fail('A subject that has sub-subjects can’t have a parent itself.')
  }
}

// Class bounds have to be class levels that exist, and the first can't come after the last.
async function assertClassRange(executor: Kysely<DB>, min: number | null, max: number | null) {
  const levels = new Set((await executor.selectFrom('classes').select('level_order').where('deleted_at', 'is', null).execute()).map((c) => c.level_order))
  const problems: { path: string; message: string }[] = []
  if (min !== null && !levels.has(min)) problems.push({ path: 'minClassOrder', message: BAD_LEVEL })
  if (max !== null && !levels.has(max)) problems.push({ path: 'maxClassOrder', message: BAD_LEVEL })
  if (problems.length === 0 && min !== null && max !== null && min > max) problems.push({ path: 'minClassOrder', message: 'The first class can’t come after the last class.' })
  if (problems.length > 0) throw validationFailed(problems, problems[0]!.message)
}

// FR-12.S2: at most 10 trending subjects. Serialised so two admins can't both take the last slot.
async function assertTrendingSlot(executor: Kysely<DB>, exceptId: string | null) {
  await sql`select pg_advisory_xact_lock(hashtext('subjects.trending'))`.execute(executor)
  let q = executor.selectFrom('subjects').select(['id', 'name']).where('is_trending', '=', true).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('name')
  if (exceptId) q = q.where('id', '!=', exceptId)
  const current = await q.execute()
  if (current.length >= MAX_TRENDING) throw new ApiError(409, 'CONFLICT_STATE', TRENDING_FULL, { trending: current })
}

function selectRows(executor: Kysely<DB>) {
  return executor
    .selectFrom('subjects')
    .leftJoin('subjects as p', 'p.id', 'subjects.parent_subject_id')
    .leftJoin('files as f', (join) => join.onRef('f.id', '=', 'subjects.icon_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select([...COLUMNS, 'p.name as parent_name', 'f.object_key as icon_key', teacherCount])
}

export const def: MasterDef<Row, SubjectView> = {
  table: 'subjects',
  noun: 'subject',
  plural: 'subjects',
  auditPrefix: 'subject',
  auditModule: 'education_masters',
  async load(executor: Kysely<DB>, id, options = {}) {
    if (options.lock) await executor.selectFrom('subjects').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('subjects.id', '=', id)
    if (!options.includeDeleted) q = q.where('subjects.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (s) => ({
    name: s.name,
    slug: s.slug,
    category: s.category,
    parentSubjectId: s.parentSubjectId,
    aliases: s.aliases,
    iconFileId: s.iconFileId,
    minClassOrder: s.minClassOrder,
    maxClassOrder: s.maxClassOrder,
    isTrending: s.isTrending,
    isActive: s.isActive,
    sortOrder: s.sortOrder,
  }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
  // Batches keep their subjects in an array column, so no foreign key points at the subject from there.
  extraReferences: async (executor, id) => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from institute_batches where deleted_at is null and ${id}::uuid = any(subject_ids)`.execute(executor)
    return { institute_batches: rows[0]?.n ?? 0 }
  },
  // A subject that was trending when deleted can't take a slot that has since been given away.
  guardRestore: async (executor, row) => {
    const parent = row.parent_subject_id
      ? await executor.selectFrom('subjects').select('id').where('id', '=', row.parent_subject_id).where('deleted_at', 'is', null).executeTakeFirst()
      : { id: null }
    if (!parent) throw conflictState(`Restore ${row.parent_name} first, then restore this subject.`)
    if (row.is_trending) await assertTrendingSlot(executor, row.id)
  },
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'subjects'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('subjects.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('subjects.is_active', '=', query.active))
    if (query.trending !== undefined) conditions.push(eb('subjects.is_trending', '=', query.trending))
    if (query.category) conditions.push(eb('subjects.category', '=', query.category))
    if (query.parentId) conditions.push(eb('subjects.parent_subject_id', '=', query.parentId))
    if (query.classId) {
      // Subjects offered for this class: its level falls in the range, and an empty bound is open-ended (FR-12.S3).
      conditions.push(sql<SqlBool>`exists (
        select 1 from classes cl where cl.id = ${query.classId}
          and (subjects.min_class_order is null or subjects.min_class_order <= cl.level_order)
          and (subjects.max_class_order is null or subjects.max_class_order >= cl.level_order))`)
    }
    if (query.q) {
      const term = query.q
      const prefix = likePrefix(term)
      conditions.push(
        eb.or([
          sql<SqlBool>`lower(subjects.name) like lower(${prefix})`,
          sql<SqlBool>`similarity(subjects.name, ${term}) > 0.3`,
          sql<SqlBool>`exists (select 1 from unnest(subjects.aliases) a where a like lower(${prefix}))`,
        ]),
      )
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'slug' | 'category' | 'parent_subject_id' | 'min_class_order' | 'max_class_order' | 'is_trending' | 'sort_order'> = {
  id: 'id',
  name: 'name',
  slug: 'slug',
  category: 'category',
  parentSubjectId: 'parent_subject_id',
  minClassOrder: 'min_class_order',
  maxClassOrder: 'max_class_order',
  isTrending: 'is_trending',
  sortOrder: 'sort_order',
}

export async function listSubjects(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted subjects.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('subjects').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'subjects.name' : field === 'createdAt' ? 'subjects.created_at' : 'subjects.sort_order'
  let rows = selectRows(db).where(where).orderBy(column, dir)
  if (column !== 'subjects.name') rows = rows.orderBy('subjects.name', 'asc')
  const result = await rows.orderBy('subjects.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.trending ?? 'any'}:${query.category ?? 'any'}:${query.parentId ?? 'any'}:${query.classId ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('subjects')
    .select(['id', 'name', 'slug', 'category', 'parent_subject_id', 'min_class_order', 'max_class_order', 'is_trending', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getSubject(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted subjects.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createSubject(ctx: Ctx, input: CreateSubjectInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      if (input.parentSubjectId) await assertParent(trx, null, input.parentSubjectId)
      await assertIcon(trx, input.iconFileId)
      await assertClassRange(trx, input.minClassOrder, input.maxClassOrder)
      if (input.isTrending) await assertTrendingSlot(trx, null)
      const inserted = await trx
        .insertInto('subjects')
        .values({
          name: input.name,
          slug: await freeSlug(trx, input.name),
          category: input.category,
          parent_subject_id: input.parentSubjectId,
          aliases: input.aliases,
          icon_file_id: input.iconFileId,
          min_class_order: input.minClassOrder,
          max_class_order: input.maxClassOrder,
          is_trending: input.isTrending,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'subject.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchSubject(ctx: Ctx, id: string, version: Date, input: PatchSubjectInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: {
      name: 'name',
      category: 'category',
      parentSubjectId: 'parent_subject_id',
      aliases: 'aliases',
      iconFileId: 'icon_file_id',
      minClassOrder: 'min_class_order',
      maxClassOrder: 'max_class_order',
      isTrending: 'is_trending',
      isActive: 'is_active',
      sortOrder: 'sort_order',
    },
    validate: async (trx, _row, before, changes) => {
      if ('parentSubjectId' in changes && changes.parentSubjectId) await assertParent(trx, id, changes.parentSubjectId as string)
      if ('iconFileId' in changes) await assertIcon(trx, changes.iconFileId as string | null)
      if ('minClassOrder' in changes || 'maxClassOrder' in changes) {
        await assertClassRange(trx, 'minClassOrder' in changes ? (changes.minClassOrder as number | null) : before.minClassOrder, 'maxClassOrder' in changes ? (changes.maxClassOrder as number | null) : before.maxClassOrder)
      }
      if (changes.isTrending === true) await assertTrendingSlot(trx, id)
    },
  })
}

export const setSubjectActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteSubject = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreSubject = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)

/**
 * FR-12.S1: moves everything that uses the source subject to the target (dropping duplicates), adds the source's name to
 * the target's aliases and removes the source. A teacher who teaches both keeps one row and their primary flag.
 */
export async function mergeSubjects(ctx: Ctx, sourceId: string, input: { intoSubjectId: string; reason?: string }) {
  const failTarget = (message: string) => validationFailed([{ path: 'intoSubjectId', message }], message)
  if (sourceId === input.intoSubjectId) throw failTarget('Pick a different subject to merge into.')

  const result = await db
    .transaction()
    .execute(async (trx) => {
      for (const id of [sourceId, input.intoSubjectId].sort()) await trx.selectFrom('subjects').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
      const source = await def.load(trx, sourceId)
      const target = await def.load(trx, input.intoSubjectId).catch((e) => {
        if (e instanceof ApiError && e.status === 404) throw failTarget('Pick the subject to merge into.')
        throw e
      })
      const child = await trx.selectFrom('subjects').select('id').where('parent_subject_id', '=', source.id).where('deleted_at', 'is', null).executeTakeFirst()
      if (child) throw conflictState('This subject has sub-subjects. Move or merge them first.')

      const moved: Record<string, number> = {}
      const count = (table: string, n: number) => {
        if (n > 0) moved[table] = (moved[table] ?? 0) + n
      }
      const handled = new Set(['teacher_subjects', 'parent_child_subjects', 'institute_teacher_subjects', 'subjects'])

      // Teachers who teach both keep the target's row, and the primary flag if only the source had it.
      const flipped = await sql<{ teacher_id: string }>`
        update teacher_subjects s set is_primary = false from teacher_subjects t
        where s.subject_id = ${source.id} and t.subject_id = ${target.id} and s.teacher_id = t.teacher_id and s.is_primary and not t.is_primary
        returning s.teacher_id`.execute(trx)
      if (flipped.rows.length > 0) {
        await sql`update teacher_subjects set is_primary = true where subject_id = ${target.id} and teacher_id = any(${flipped.rows.map((r) => r.teacher_id)}::uuid[])`.execute(trx)
      }
      const droppedTeachers = await sql`delete from teacher_subjects s using teacher_subjects t where s.subject_id = ${source.id} and t.subject_id = ${target.id} and s.teacher_id = t.teacher_id`.execute(trx)
      const movedTeachers = await sql`update teacher_subjects set subject_id = ${target.id} where subject_id = ${source.id}`.execute(trx)
      count('teacher_subjects', Number(droppedTeachers.numAffectedRows ?? 0) + Number(movedTeachers.numAffectedRows ?? 0))

      const droppedChildren = await sql`delete from parent_child_subjects s using parent_child_subjects t where s.subject_id = ${source.id} and t.subject_id = ${target.id} and s.child_id = t.child_id`.execute(trx)
      const movedChildren = await sql`update parent_child_subjects set subject_id = ${target.id} where subject_id = ${source.id}`.execute(trx)
      count('parent_child_subjects', Number(droppedChildren.numAffectedRows ?? 0) + Number(movedChildren.numAffectedRows ?? 0))

      const droppedStaff = await sql`delete from institute_teacher_subjects s using institute_teacher_subjects t where s.subject_id = ${source.id} and t.subject_id = ${target.id} and s.institute_teacher_id = t.institute_teacher_id`.execute(trx)
      const movedStaff = await sql`update institute_teacher_subjects set subject_id = ${target.id} where subject_id = ${source.id}`.execute(trx)
      count('institute_teacher_subjects', Number(droppedStaff.numAffectedRows ?? 0) + Number(movedStaff.numAffectedRows ?? 0))

      // Any other table with a foreign key to subjects (leads today, more later) is simply repointed.
      for (const fk of await foreignKeysTo(trx, 'subjects')) {
        if (handled.has(fk.table)) continue
        const res = await sql`update ${sql.table(fk.table)} set ${sql.ref(fk.column)} = ${target.id} where ${sql.ref(fk.column)} = ${source.id}`.execute(trx)
        count(fk.table, Number(res.numAffectedRows ?? 0))
      }

      // Batches keep subject ids in an array: swap the id and drop a repeat.
      const batches = await sql`
        update institute_batches set subject_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(subject_ids, ${source.id}::uuid, ${target.id}::uuid)) x)
        where ${source.id}::uuid = any(subject_ids)`.execute(trx)
      count('institute_batches', Number(batches.numAffectedRows ?? 0))

      const alias = source.name.toLowerCase()
      const aliasAdded = !target.aliases.includes(alias) && alias !== target.name.toLowerCase() && target.aliases.length < MAX_ALIASES
      if (aliasAdded) await trx.updateTable('subjects').set({ aliases: [...target.aliases, alias], updated_by: ctx.actor.id }).where('id', '=', target.id).execute()
      else await trx.updateTable('subjects').set({ updated_by: ctx.actor.id }).where('id', '=', target.id).execute()
      await trx.updateTable('subjects').set({ is_trending: false, deleted_at: sql`now()`, deleted_by: ctx.actor.id, updated_by: ctx.actor.id }).where('id', '=', source.id).execute()

      await audit(trx, {
        ...auditBase(ctx, def, source.id),
        action: 'subject.merged',
        oldValues: { name: source.name, aliases: source.aliases },
        newValues: { intoSubjectId: target.id, intoName: target.name, moved, aliasAdded },
        reason: input.reason ?? null,
      })
      return { subject: present(await def.load(trx, target.id)), moved, aliasAdded }
    })
    .catch((e) => {
      if ((e as { code?: string })?.code === '23505') throw conflictState("These subjects can't be merged automatically: some records refer to both of them.")
      throw e
    })
  await cache.purge()
  return result
}
