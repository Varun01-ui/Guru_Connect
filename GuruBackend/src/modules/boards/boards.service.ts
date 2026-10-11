import { sql } from 'kysely'
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { forbidden, notFound, validationFailed } from '../../lib/errors.js'
import { createDropdownCache } from '../../lib/masters/dropdownCache.js'
import { auditBase, deleteMaster, duplicateError, patchMaster, restoreMaster, setMasterActive } from '../../lib/masters/kernel.js'
import type { Ctx, MasterDef } from '../../lib/masters/kernel.js'
import { likePrefix, pageMeta } from '../../lib/masters/query.js'
import { STATE_NOT_ALLOWED, STATE_REQUIRED } from './boards.schemas.js'
import type { CreateBoardInput, DropdownField, ListQuery, PatchBoardInput } from './boards.schemas.js'

export type { Ctx }

const COLUMNS = [
  'boards.id',
  'boards.name',
  'boards.short_name',
  'boards.type',
  'boards.state_id',
  'boards.is_active',
  'boards.sort_order',
  'boards.created_at',
  'boards.updated_at',
  'boards.deleted_at',
] as const
// Live records that point at the board; this is what a delete would orphan.
const usageCount = sql<number>`(
  (select count(*) from teacher_classes tc where tc.board_id = boards.id)
  + (select count(*) from parent_children pc where pc.board_id = boards.id and pc.deleted_at is null)
  + (select count(*) from students s where s.board_id = boards.id and s.deleted_at is null)
)::int`.as('usage_count')

const NOT_FOUND = 'Board not found.'
const BAD_PARENT = 'Pick an active parent record.'
const DROPDOWN_CAP = 5000
const cache = createDropdownCache('boards')

type Row = {
  id: string
  name: string
  short_name: string
  type: 'national' | 'state' | 'international' | 'university' | 'other'
  state_id: string | null
  state_name: string | null
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  usage_count: number
}

function present(r: Row) {
  return {
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    type: r.type,
    state: r.state_id ? { id: r.state_id, name: r.state_name! } : null,
    stateId: r.state_id,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    usageCount: r.usage_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }
}
export type BoardView = ReturnType<typeof present>

function mapDuplicate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code !== '23505') return e
  return duplicateError('A board with this name already exists.', 'shortName')
}

async function assertActiveState(executor: Kysely<DB>, stateId: string) {
  const state = await executor.selectFrom('states').select('id').where('id', '=', stateId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
  if (!state) throw validationFailed([{ path: 'stateId', message: BAD_PARENT }], BAD_PARENT)
}

function selectRows(executor: Kysely<DB>) {
  return executor.selectFrom('boards').leftJoin('states as s', 's.id', 'boards.state_id').select([...COLUMNS, 's.name as state_name', usageCount])
}

const def: MasterDef<Row, BoardView> = {
  table: 'boards',
  noun: 'board',
  plural: 'boards',
  auditPrefix: 'board',
  auditModule: 'education_masters',
  async load(executor: Kysely<DB>, id, options = {}) {
    if (options.lock) await executor.selectFrom('boards').select('id').where('id', '=', id).forUpdate().executeTakeFirst()
    let q = selectRows(executor).where('boards.id', '=', id)
    if (!options.includeDeleted) q = q.where('boards.deleted_at', 'is', null)
    const row = await q.executeTakeFirst()
    if (!row) throw notFound(NOT_FOUND)
    return row as Row
  },
  present,
  snapshot: (b) => ({ name: b.name, shortName: b.shortName, type: b.type, stateId: b.stateId, isActive: b.isActive, sortOrder: b.sortOrder }),
  purgeCache: () => cache.purge(),
  mapDuplicate,
}

// ------------------------------------------------------------------ reads

function filterWhere(query: ListQuery, includeDeleted: boolean) {
  return (eb: ExpressionBuilder<DB, 'boards'>) => {
    const conditions: Expression<SqlBool>[] = []
    if (!includeDeleted) conditions.push(eb('boards.deleted_at', 'is', null))
    if (query.active !== undefined) conditions.push(eb('boards.is_active', '=', query.active))
    if (query.type) conditions.push(eb('boards.type', '=', query.type))
    if (query.stateId) conditions.push(eb('boards.state_id', '=', query.stateId))
    if (query.q) {
      const term = query.q
      const prefix = likePrefix(term)
      conditions.push(
        eb.or([
          sql<SqlBool>`lower(boards.short_name) like lower(${prefix})`,
          sql<SqlBool>`lower(boards.name) like lower(${prefix})`,
          sql<SqlBool>`similarity(boards.name, ${term}) > 0.3`,
          sql<SqlBool>`similarity(boards.short_name, ${term}) > 0.3`,
        ]),
      )
    }
    return eb.and(conditions)
  }
}

const DROPDOWN_COLUMN: Record<DropdownField, 'id' | 'name' | 'short_name' | 'type' | 'state_id' | 'sort_order'> = {
  id: 'id',
  name: 'name',
  shortName: 'short_name',
  type: 'type',
  stateId: 'state_id',
  sortOrder: 'sort_order',
}

export async function listBoards(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted boards.')

  if (query.fields) return { data: await dropdown(query), meta: undefined }

  const where = filterWhere(query, includeDeleted)
  const total = Number((await db.selectFrom('boards').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'sortOrder:asc').split(':') as ['name' | 'sortOrder' | 'createdAt', 'asc' | 'desc']
  const column = field === 'name' ? 'boards.name' : field === 'createdAt' ? 'boards.created_at' : 'boards.sort_order'
  let rows = selectRows(db).where(where).orderBy(column, dir)
  if (column !== 'boards.name') rows = rows.orderBy('boards.name', 'asc')
  const result = await rows.orderBy('boards.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()

  return { data: (result as Row[]).map(present), meta: pageMeta(query.page, query.pageSize, total) }
}

async function dropdown(query: ListQuery): Promise<Record<string, unknown>[]> {
  const fields = query.fields!
  const variant = `${query.active ?? 'any'}:${query.type ?? 'any'}:${query.stateId ?? 'any'}:${fields.join(',')}`
  const cacheable = !query.q
  if (cacheable) {
    const hit = await cache.get<Record<string, unknown>[]>(variant)
    if (hit) return hit
  }
  const rows = await db
    .selectFrom('boards')
    .select(['id', 'name', 'short_name', 'type', 'state_id', 'sort_order'])
    .where(filterWhere(query, false))
    .orderBy('sort_order', 'asc')
    .orderBy('short_name', 'asc')
    .limit(DROPDOWN_CAP)
    .execute()
  const data = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[DROPDOWN_COLUMN[f]]])))
  if (cacheable) await cache.set(variant, data)
  return data
}

export async function getBoard(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted boards.')
  return present(await def.load(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ writes

export async function createBoard(ctx: Ctx, input: CreateBoardInput) {
  const created = await db
    .transaction()
    .execute(async (trx) => {
      if (input.stateId) await assertActiveState(trx, input.stateId)
      const inserted = await trx
        .insertInto('boards')
        .values({ name: input.name, short_name: input.shortName, type: input.type, state_id: input.stateId, is_active: input.isActive, sort_order: input.sortOrder, created_by: ctx.actor.id, updated_by: ctx.actor.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      const view = present(await def.load(trx, inserted.id))
      await audit(trx, { ...auditBase(ctx, def, view.id), action: 'board.created', newValues: def.snapshot(view) })
      return view
    })
    .catch((e) => {
      throw mapDuplicate(e)
    })
  await cache.purge()
  return created
}

export function patchBoard(ctx: Ctx, id: string, version: Date, input: PatchBoardInput) {
  return patchMaster(def, ctx, id, version, input, {
    columns: { name: 'name', shortName: 'short_name', type: 'type', stateId: 'state_id', isActive: 'is_active', sortOrder: 'sort_order' },
    // A state board needs a state and every other board must not have one, judged on the values after the change.
    validate: async (trx, _row, before, changes) => {
      const type = (changes.type as string | undefined) ?? before.type
      const stateId = 'stateId' in changes ? (changes.stateId as string | null) : before.stateId
      if (type === 'state' && !stateId) throw validationFailed([{ path: 'stateId', message: STATE_REQUIRED }], STATE_REQUIRED)
      if (type !== 'state' && stateId) throw validationFailed([{ path: 'stateId', message: STATE_NOT_ALLOWED }], STATE_NOT_ALLOWED)
      if ('stateId' in changes && stateId) await assertActiveState(trx, stateId)
    },
  })
}

export const setBoardActive = (ctx: Ctx, id: string, active: boolean, reason?: string) => setMasterActive(def, ctx, id, active, reason)
export const deleteBoard = (ctx: Ctx, id: string) => deleteMaster(def, ctx, id)
export const restoreBoard = (ctx: Ctx, id: string) => restoreMaster(def, ctx, id)
