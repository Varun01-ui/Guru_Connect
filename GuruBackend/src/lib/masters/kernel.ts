import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import type { Ctx } from '../../modules/rbac/rbac.service.js'
import { audit } from '../audit.js'
import { ApiError, conflictState, notFound, validationFailed } from '../errors.js'
import { countReferences } from './references.js'

export type { Ctx }

export type MasterTable = 'countries' | 'states' | 'cities' | 'areas' | 'classes' | 'subjects' | 'boards' | 'teaching_modes' | 'teacher_categories'

export type BaseRow = { id: string; is_active: boolean; updated_at: Date; deleted_at: Date | null }
export type BaseView = { id: string; isActive: boolean; updatedAt: string; deletedAt: string | null }
export type LoadOptions = { lock?: boolean; includeDeleted?: boolean }

// What differs between master-data modules. The mutation skeletons below (patch, activate, delete, restore, reorder)
// are identical for all of them: lock the row, check, change, audit in the same transaction, purge the dropdown cache.
export type MasterDef<Row extends BaseRow, View extends BaseView> = {
  table: MasterTable
  /** Lower-case singular for messages: "country", "teaching mode". */
  noun: string
  /** Lower-case plural: "countries", "classes". */
  plural: string
  /** Audit action prefix: "country" gives country.created, country.updated ... */
  auditPrefix: string
  /** Audit module, normally the permission group ("locations", "education_masters"). */
  auditModule: string
  /** Loads one row with whatever counts the view needs; throws NOT_FOUND ("Country not found.") when absent. */
  load: (executor: Kysely<DB>, id: string, options?: LoadOptions) => Promise<Row>
  present: (row: Row) => View
  /** The editable fields written to audit_logs (no counts or timestamps). */
  snapshot: (view: View) => Record<string, unknown>
  purgeCache: () => Promise<void>
  /** Turns a PostgreSQL 23505 into CONFLICT_DUPLICATE for the field that clashed; returns other errors unchanged. */
  mapDuplicate: (error: unknown) => unknown
  guardDeactivate?: (row: Row) => void
  guardDelete?: (row: Row) => void
  /** References that aren't foreign keys (e.g. ids stored in an array column), counted with the discovered ones when deleting. */
  extraReferences?: (executor: Kysely<DB>, id: string) => Promise<Record<string, number>>
  /** Runs inside the restore transaction, e.g. to refuse restoring a child of a deleted parent. */
  guardRestore?: (executor: Kysely<DB>, row: Row) => Promise<void> | void
}

export const auditBase = (ctx: Ctx, def: Pick<MasterDef<never, never>, 'auditModule' | 'table'>, entityId: string) => ({
  actorType: 'admin' as const,
  actorId: ctx.actor.id,
  actorEmail: ctx.actor.email,
  module: def.auditModule,
  entityType: def.table,
  entityId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  requestId: ctx.requestId,
})

export const staleError = (noun: string, current: unknown) =>
  new ApiError(409, 'VERSION_CONFLICT', `Someone else changed this ${noun}. Reload.`, { current })

export const inUseError = (noun: string, references: Record<string, number>) =>
  new ApiError(409, 'CONFLICT_IN_USE', `This ${noun} is in use. Deactivate it instead.`, { references })

export const duplicateError = (message: string, field: string) => new ApiError(409, 'CONFLICT_DUPLICATE', message, { field })

// Arrays (PIN codes, aliases) are values, not identities: the same items in the same order are no change.
const sameValue = (a: unknown, b: unknown) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]))

const withMappedDuplicates = <T>(def: { mapDuplicate: (e: unknown) => unknown }, run: () => Promise<T>) =>
  run().catch((e) => {
    throw def.mapDuplicate(e)
  })

// Generic UPDATE for the columns every master table shares plus the module's own. The table name is a runtime value,
// so the builder is typed against one table and cast; the column names always come from module code, never input.
function update(trx: Kysely<DB>, table: MasterTable, id: string, values: Record<string, unknown>) {
  return trx.updateTable(table as 'countries').set(values as never).where('id', '=', id).execute()
}

export type PatchOptions<Row extends BaseRow, View extends BaseView> = {
  /** Request field -> database column. Only these fields can be changed. */
  columns: Record<string, string>
  /** Runs inside the transaction, after the version check, before the UPDATE; throw to refuse the change. */
  validate?: (trx: Kysely<DB>, row: Row, before: View, changes: Record<string, unknown>) => Promise<void> | void
}

export async function patchMaster<Row extends BaseRow, View extends BaseView>(
  def: MasterDef<Row, View>,
  ctx: Ctx,
  id: string,
  version: Date,
  input: Record<string, unknown>,
  options: PatchOptions<Row, View>,
): Promise<View> {
  const updated = await withMappedDuplicates(def, () =>
    db.transaction().execute(async (trx) => {
      const row = await def.load(trx, id, { lock: true })
      const before = def.present(row)
      if (row.updated_at.getTime() !== version.getTime()) throw staleError(def.noun, before)

      const changes = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !sameValue(v, (before as Record<string, unknown>)[k])))
      if (Object.keys(changes).length === 0) return before

      await options.validate?.(trx, row, before, changes)

      const set: Record<string, unknown> = { updated_by: ctx.actor.id }
      for (const [k, v] of Object.entries(changes)) set[options.columns[k]!] = v
      await update(trx, def.table, id, set)

      const after = def.present(await def.load(trx, id))
      await audit(trx, {
        ...auditBase(ctx, def, id),
        action: `${def.auditPrefix}.updated`,
        oldValues: Object.fromEntries(Object.keys(changes).map((k) => [k, (before as Record<string, unknown>)[k]])),
        newValues: Object.fromEntries(Object.keys(changes).map((k) => [k, (after as Record<string, unknown>)[k]])),
      })
      return after
    }),
  )
  await def.purgeCache()
  return updated
}

export async function setMasterActive<Row extends BaseRow, View extends BaseView>(def: MasterDef<Row, View>, ctx: Ctx, id: string, active: boolean, reason?: string) {
  const result = await db.transaction().execute(async (trx) => {
    const row = await def.load(trx, id, { lock: true })
    if (!active) def.guardDeactivate?.(row)
    if (row.is_active === active) return { view: def.present(row), changed: false }
    await update(trx, def.table, id, { is_active: active, updated_by: ctx.actor.id })
    const view = def.present(await def.load(trx, id))
    await audit(trx, {
      ...auditBase(ctx, def, id),
      action: `${def.auditPrefix}.${active ? 'activated' : 'deactivated'}`,
      oldValues: { isActive: !active },
      newValues: { isActive: active },
      reason: reason ?? null,
    })
    return { view, changed: true }
  })
  if (result.changed) await def.purgeCache()
  return result.view
}

export async function deleteMaster<Row extends BaseRow, View extends BaseView>(def: MasterDef<Row, View>, ctx: Ctx, id: string) {
  await db.transaction().execute(async (trx) => {
    // The row lock also blocks a concurrent insert of a referencing row (its FK check takes a share lock on this row).
    const row = await def.load(trx, id, { lock: true })
    def.guardDelete?.(row)
    const references = { ...(await countReferences(trx, def.table, id)), ...(await def.extraReferences?.(trx, id)) }
    for (const key of Object.keys(references)) if (references[key] === 0) delete references[key]
    if (Object.keys(references).length > 0) throw inUseError(def.noun, references)
    await update(trx, def.table, id, { deleted_at: sql`now()`, deleted_by: ctx.actor.id, updated_by: ctx.actor.id })
    await audit(trx, { ...auditBase(ctx, def, id), action: `${def.auditPrefix}.deleted`, oldValues: def.snapshot(def.present(row)) })
  })
  await def.purgeCache()
}

export async function restoreMaster<Row extends BaseRow, View extends BaseView>(def: MasterDef<Row, View>, ctx: Ctx, id: string) {
  if (!ctx.actor.isSuperAdmin) throw new ApiError(403, 'FORBIDDEN', `Only a Super Admin can restore a ${def.noun}.`)
  const restored = await withMappedDuplicates(def, () =>
    db.transaction().execute(async (trx) => {
      const row = await def.load(trx, id, { lock: true, includeDeleted: true })
      if (!row.deleted_at) throw conflictState(`This ${def.noun} is not deleted.`)
      await def.guardRestore?.(trx, row)
      await update(trx, def.table, id, { deleted_at: null, deleted_by: null, updated_by: ctx.actor.id })
      const view = def.present(await def.load(trx, id))
      await audit(trx, { ...auditBase(ctx, def, id), action: `${def.auditPrefix}.restored`, newValues: def.snapshot(view) })
      return view
    }),
  )
  await def.purgeCache()
  return restored
}

/**
 * PUT /<resource>/order. Rewrites `column` to 1..n following `ids`, which must be exactly the live rows (no gaps,
 * duplicates or strangers), so the stored order is always a clean permutation. `scope` narrows "all live rows" for
 * tables ordered within a parent.
 */
export async function reorderMaster(def: Pick<MasterDef<never, never>, 'table' | 'plural' | 'auditPrefix' | 'auditModule' | 'purgeCache'>, ctx: Ctx, column: 'sort_order' | 'level_order', ids: string[]) {
  await db.transaction().execute(async (trx) => {
    const live = await trx.selectFrom(def.table as 'countries').select(['id', column as 'sort_order']).where('deleted_at', 'is', null).orderBy(column as 'sort_order').orderBy('id').forUpdate().execute()
    const liveIds = new Set(live.map((r) => r.id))
    const problems: { path: string; message: string }[] = []
    if (new Set(ids).size !== ids.length) problems.push({ path: 'ids', message: 'Each id can appear only once.' })
    if (ids.some((id) => !liveIds.has(id))) problems.push({ path: 'ids', message: `Some ids are not ${def.plural}.` })
    if (problems.length === 0 && ids.length !== live.length) problems.push({ path: 'ids', message: `Send every one of the ${def.plural}, in the order you want.` })
    if (problems.length > 0) throw validationFailed(problems, problems[0]!.message)

    const before = live.map((r) => r.id)
    if (before.every((id, i) => id === ids[i])) return
    for (const [i, id] of ids.entries()) await update(trx, def.table, id, { [column]: i + 1, updated_by: ctx.actor.id })
    await audit(trx, {
      ...auditBase(ctx, def, ids[0]!),
      action: `${def.auditPrefix}.reordered`,
      oldValues: { ids: before },
      newValues: { ids },
    })
  })
  await def.purgeCache()
}

export { notFound }
