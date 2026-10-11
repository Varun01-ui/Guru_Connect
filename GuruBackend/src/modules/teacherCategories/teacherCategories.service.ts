import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, reorderMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { cdnUrl } from '../../lib/present.js'
import { slugify } from '../../lib/slug.js'
import type { CreateTeacherCategoryInput, DropdownField, ListQuery, PatchTeacherCategoryInput } from './teacherCategories.schemas.js'

export type { Ctx }

const COLUMNS = [
  'teacher_categories.id',
  'teacher_categories.name',
  'teacher_categories.slug',
  'teacher_categories.description',
  'teacher_categories.icon_file_id',
  'teacher_categories.is_active',
  'teacher_categories.sort_order',
  'teacher_categories.created_at',
  'teacher_categories.updated_at',
  'teacher_categories.deleted_at',
] as const
const teacherCount = sql<number>`(select count(*)::int from teachers t where t.category_id = teacher_categories.id and t.deleted_at is null)`.as('teacher_count')
const childPreferenceCount = sql<number>`(select count(*)::int from parent_child_teacher_categories pc join parent_children c on c.id = pc.child_id and c.deleted_at is null where pc.category_id = teacher_categories.id)`.as('child_preference_count')

const NOT_FOUND = 'Teacher category not found.'
const BAD_ICON = 'Pick an uploaded category icon.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('teacher-categories')

type Row = {
  id: string
  name: string
  slug: string
  description: string | null
  icon_file_id: string | null
  icon_key: string | null
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  teacher_count: number
  child_preference_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    iconFileId: r.icon_file_id,
    iconUrl: cdnUrl(r.icon_key),
    isActive: r.is_active,
    sortOrder: r.sort_order,
    teacherCount: r.teacher_count,
    childPreferenceCount: r.child_preference_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type TeacherCategoryView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  if (err.constraint === 'uq_teacher_categories_slug') return duplicateError('A teacher category with this slug already exists.', 'name')
  return duplicateError('A teacher category with this name already exists.', 'name')
}

// The icon has to be a finished, public upload for this purpose; the CDN URL is built from its object key.
async function assertIcon(executor: Kysely<DB>, fileId: string | null) {
  if (fileId === null) return
  const file = await executor
    .selectFrom('files')
    .select('id')
    .where('id', '=', fileId)
    .where('purpose', '=', 'category_icon')
    .where('status', '=', 'uploaded')
    .where('visibility', '=', 'public')
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (!file) throw validationFailed([{ path: 'iconFileId', message: BAD_ICON }], BAD_ICON)
}

// "Sports Coach" -> "sports-coach"; "Sports Coach" again -> "sports-coach-2". The slug is fixed at creation, so links
// to a category survive a rename.
async function freeSlug(executor: Kysely<DB>, name: string): Promise<string> {
  const base = /[a-z0-9]/i.test(name.normalize('NFKD')) ? slugify(name) : 'category'
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 76)}-${n}`
    const taken = await executor.selectFrom('teacher_categories').select('id').where('slug', '=', candidate).where('deleted_at', 'is', null).executeTakeFirst()
    if (!taken) return candidate
  }
}

function selectRows(executor: Kysely<DB>) {
  return executor
    .selectFrom('teacher_categories')
    .leftJoin('files as f', (join) => join.onRef('f.id', '=', 'teacher_categories.icon_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select([...COLUMNS, 'f.object_key as icon_key', teacherCount, childPreferenceCount])
}

const def: MasterDef<Row, TeacherCategoryView> = {
  table: 'teacher_categories',
  noun: 'teacher category',
  plural: 'teacher categories',
  auditPrefix: 'teacher_category',
  auditModule: 'education_masters',
  async load(executor: Kysely<DB>, id, options = {}) {
    // FOR UPDATE can't be applied to a query with an outer join, so the category row is locked first on its own
    // (the lock lasts for the transaction) and then read together with its icon.
    if (options.lock) await executor.selectFrom('teacher_categories').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('teacher_categories.id', '=', id)
    if (!options.includeDeleted) q = q.where('teacher_categories.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (c) => ({ name: c.name, slug: c.slug, description: c.description, iconFileId: c.iconFileId, isActive: c.isActive, sortOrder: c.sortOrder }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'teacher_categories'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('teacher_categories.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('teacher_categories.is_active', '=', query.active))
    if (query.q) {
      const prefix = likePrefix(query.q)
      conditions.push(eb.or([sql<SqlBool>`lower(teacher_categories.name) like lower(${prefix})`, sql<SqlBool>`teacher_categories.slug like lower(${prefix})`]))
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'slug' | 'sort_order'> = { id: 'id', name: 'name', slug: 'slug', sortOrder: 'sort_order' }

export async function listTeacherCategories(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted teacher categories.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('teacher_categories').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'teacher_categories.name' : field === 'createdAt' ? 'teacher_categories.created_at' : 'teacher_categories.sort_order'
  let rows = selectRows(db).where(where).orderBy(column, dir)
  if (column !== 'teacher_categories.name') rows = rows.orderBy('teacher_categories.name', 'asc')
  const result = await rows.orderBy('teacher_categories.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('teacher_categories')
    .select(['id', 'name', 'slug', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getTeacherCategory(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted teacher categories.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createTeacherCategory(ctx: Ctx, input: CreateTeacherCategoryInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      await assertIcon(trx, input.iconFileId)
      const inserted = await trx
        .insertInto('teacher_categories')
        .values({
          name: input.name,
          slug: await freeSlug(trx, input.name),
          description: input.description,
          icon_file_id: input.iconFileId,
          is_active: input.isActive,
          sort_order: input.sortOrder,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'teacher_category.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchTeacherCategory(ctx: Ctx, id: string, version: Date, input: PatchTeacherCategoryInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { name: 'name', description: 'description', iconFileId: 'icon_file_id', isActive: 'is_active', sortOrder: 'sort_order' },
    validate: async (trx, _row, _before, changes) => {
      if ('iconFileId' in changes) await assertIcon(trx, changes.iconFileId as string | null)
    },
  })
}

export const setTeacherCategoryActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteTeacherCategory = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreTeacherCategory = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
// FR-15.S1: rewrites sort_order to 1..n; the first 8 active categories fill the app's home grid.
export const reorderTeacherCategories = (ctx: Ctx, ids: string[]) => reorderMaster(def, ctx, 'sort_order', ids)
