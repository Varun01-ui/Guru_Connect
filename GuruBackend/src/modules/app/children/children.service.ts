import type { Kysely } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'
import { audit } from '../../../lib/audit.js'
import { forbidden, limitReached, notFound, validationFailed, versionConflict } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { getSettingByKey } from '../bootstrap/bootstrap.repository.js'
import { computeRecommendationsPreview, invalidateChildRecommendations } from './children.recommendations.js'
import * as repo from './children.repository.js'
import type { CreateChildBody, UpdateChildBody } from './children.schemas.js'

export type ParentContext = { parentId: string; userId: string; ip: string | null }

type FieldError = { path: string; message: string }

// ---------- presentation ----------

async function present(rows: repo.ChildRow[]) {
  const { subjects, categories } = await repo.loadChildRelations(rows.map((r) => r.id))
  return rows.map((row) => {
    const childSubjects = subjects.filter((s) => s.child_id === row.id)
    const childCategories = categories.filter((c) => c.child_id === row.id)
    return {
      id: row.id,
      childName: row.child_name,
      classId: row.class_id,
      class: { id: row.class_id, name: row.class_name },
      boardId: row.board_id,
      board: row.board_id ? { id: row.board_id, name: row.board_name, shortName: row.board_short_name } : null,
      subjectIds: childSubjects.map((s) => s.id),
      subjects: childSubjects.map((s) => s.name),
      categoryIds: childCategories.map((c) => c.id),
      teacherCategories: childCategories.map((c) => c.name),
      preferredModeId: row.preferred_mode_id,
      preferredMode: row.preferred_mode_id ? { id: row.preferred_mode_id, name: row.preferred_mode_name } : null,
      schoolName: row.school_name,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}

async function presentOne(childId: string) {
  const row = await repo.findChildRow(childId)
  if (!row) throw notFound('Child not found.')
  const [child] = await present([row])
  return child!
}

// ---------- validation (BR-7.2 / BR-7.3) ----------

const offeredForClass = (subject: { min_class_order: number | null; max_class_order: number | null }, levelOrder: number) =>
  (subject.min_class_order === null || subject.min_class_order <= levelOrder) && (subject.max_class_order === null || subject.max_class_order >= levelOrder)

async function maxChildren(): Promise<number> {
  return Number((await getSettingByKey('limits.parent_max_children')) ?? 3)
}

async function validateBoard(boardId: string, parentStateId: string | null, errors: FieldError[]) {
  const board = await repo.findActiveBoard(boardId)
  // A state board must be the parent's own state; national/international/university/other boards are open to all.
  if (!board || (board.state_id !== null && board.state_id !== parentStateId)) {
    errors.push({ path: 'boardId', message: 'Choose a board available in your state.' })
  }
}

async function validateSubjectsForClass(subjectIds: string[], cls: { name: string; level_order: number }, errors: FieldError[]) {
  const found = await repo.findActiveSubjects(subjectIds)
  for (const id of subjectIds) {
    const subject = found.find((s) => s.id === id)
    if (!subject) errors.push({ path: 'subjectIds', message: 'Choose valid subjects.' })
    else if (!offeredForClass(subject, cls.level_order)) errors.push({ path: 'subjectIds', message: `${subject.name} isn't offered for ${cls.name}.` })
  }
}

async function validateCategories(categoryIds: string[], errors: FieldError[]) {
  const found = await repo.findActiveCategories(categoryIds)
  if (found.length !== categoryIds.length) errors.push({ path: 'categoryIds', message: 'Choose valid teacher types.' })
}

async function validateMode(modeId: string, errors: FieldError[]) {
  if (!(await repo.findActiveMode(modeId))) errors.push({ path: 'preferredModeId', message: 'Choose a valid teaching mode.' })
}

function throwIfErrors(errors: FieldError[]) {
  if (errors.length > 0) throw validationFailed(errors)
}

// ---------- reads ----------

export async function listChildren(ctx: ParentContext) {
  return present(await repo.listChildRows(ctx.parentId))
}

// ---------- create ----------

export async function createChild(ctx: ParentContext, body: CreateChildBody, idempotencyKey: string) {
  const cacheKey = `child:${ctx.userId}:${idempotencyKey}`
  const cached = await getIdempotent(cacheKey)
  if (cached) return cached.body

  const limit = await maxChildren()

  const childId = await db.transaction().execute(async (trx) => {
    // Lock the parent row so two simultaneous creates can't both slip under the limit (BR-7.1).
    await repo.lockParent(ctx.parentId, trx)
    const current = await repo.countLiveChildren(ctx.parentId, trx)
    if (current >= limit) throw limitReached(limit, current)

    const errors: FieldError[] = []
    const cls = await repo.findActiveClass(body.classId, trx)
    if (!cls) errors.push({ path: 'classId', message: 'Choose a class.' })
    if (body.boardId) await validateBoard(body.boardId, await repo.getParentState(ctx.parentId, trx), errors)
    if (cls) await validateSubjectsForClass(body.subjectIds, cls, errors)
    await validateCategories(body.categoryIds, errors)
    if (body.preferredModeId) await validateMode(body.preferredModeId, errors)
    throwIfErrors(errors)

    const created = await repo.insertChild(trx, {
      parentId: ctx.parentId,
      childName: body.childName,
      classId: body.classId,
      boardId: body.boardId ?? null,
      preferredModeId: body.preferredModeId ?? null,
      schoolName: body.schoolName ?? null,
      sortOrder: await repo.nextSortOrder(ctx.parentId, trx),
    })
    await repo.replaceSubjects(trx, created.id, body.subjectIds)
    await repo.replaceCategories(trx, created.id, body.categoryIds)

    await auditChange(trx, ctx, 'app.child_added', created.id, { classId: body.classId, subjectsCount: body.subjectIds.length, categoriesCount: body.categoryIds.length })
    return created.id
  })

  await invalidateChildRecommendations(childId)
  const response = { data: await presentOne(childId), meta: { recommendationsPreview: await computeRecommendationsPreview(childId) } }
  await putIdempotent(cacheKey, 201, response)
  return response
}

// ---------- update ----------

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

export async function updateChild(ctx: ParentContext, childId: string, version: Date, body: UpdateChildBody) {
  const result = await db.transaction().execute(async (trx) => {
    const existing = await repo.findChildRow(childId, trx)
    if (!existing) throw notFound('Child not found.')
    if (existing.parent_id !== ctx.parentId) throw forbidden("You can't do that.")
    // Checked before validation so a stale form gets VERSION_CONFLICT rather than a confusing field error.
    if (Math.abs(existing.updated_at.getTime() - version.getTime()) > 1) throw versionConflict()

    const relations = await repo.loadChildRelations([childId], trx)
    const currentSubjects = relations.subjects.map((s) => ({ id: s.id, name: s.name, min_class_order: s.min_class_order, max_class_order: s.max_class_order }))
    const currentCategoryIds = relations.categories.map((c) => c.id)

    const errors: FieldError[] = []
    const classChanged = body.classId !== undefined && body.classId !== existing.class_id
    let cls: { name: string; level_order: number } = { name: existing.class_name, level_order: existing.class_level_order }
    if (body.classId !== undefined) {
      const found = await repo.findActiveClass(body.classId, trx)
      if (!found) errors.push({ path: 'classId', message: 'Choose a class.' })
      else cls = found
    }

    if (body.boardId) await validateBoard(body.boardId, await repo.getParentState(ctx.parentId, trx), errors)
    if (body.categoryIds) await validateCategories(body.categoryIds, errors)
    if (body.preferredModeId) await validateMode(body.preferredModeId, errors)

    // Subjects: an explicit list is validated strictly; otherwise a class change silently drops the saved subjects
    // that the new class doesn't offer (BR-7.3) and reports them so the app can show a toast.
    let nextSubjectIds = currentSubjects.map((s) => s.id)
    const droppedSubjects: string[] = []
    if (body.subjectIds) {
      await validateSubjectsForClass(body.subjectIds, cls, errors)
      nextSubjectIds = body.subjectIds
    } else if (classChanged) {
      for (const subject of currentSubjects) {
        if (offeredForClass(subject, cls.level_order)) continue
        droppedSubjects.push(subject.name)
        nextSubjectIds = nextSubjectIds.filter((id) => id !== subject.id)
      }
    }
    throwIfErrors(errors)

    const nextCategoryIds = body.categoryIds ?? currentCategoryIds
    const boardChanged = body.boardId !== undefined && body.boardId !== existing.board_id
    const modeChanged = body.preferredModeId !== undefined && body.preferredModeId !== existing.preferred_mode_id
    const subjectsChanged = !sameSet(nextSubjectIds, currentSubjects.map((s) => s.id))
    const categoriesChanged = !sameSet(nextCategoryIds, currentCategoryIds)
    // A name/school-only edit never changes who is a good match, so it skips the recompute and the preview sheet.
    const qualifying = classChanged || boardChanged || modeChanged || subjectsChanged || categoriesChanged

    const applied = await repo.updateChildIfVersion(trx, childId, version, {
      ...(body.childName !== undefined ? { child_name: body.childName } : {}),
      ...(body.classId !== undefined ? { class_id: body.classId } : {}),
      ...(body.boardId !== undefined ? { board_id: body.boardId } : {}),
      ...(body.preferredModeId !== undefined ? { preferred_mode_id: body.preferredModeId } : {}),
      ...(body.schoolName !== undefined ? { school_name: body.schoolName } : {}),
    })
    if (!applied) throw versionConflict()

    if (subjectsChanged) await repo.replaceSubjects(trx, childId, nextSubjectIds)
    if (categoriesChanged) await repo.replaceCategories(trx, childId, nextCategoryIds)

    if (qualifying) {
      await auditChange(trx, ctx, 'app.child_updated', childId, {
        changedFields: Object.keys(body),
        ...(droppedSubjects.length > 0 ? { droppedSubjects } : {}),
      })
    }
    return { qualifying, droppedSubjects }
  })

  if (result.qualifying) await invalidateChildRecommendations(childId)
  return {
    data: await presentOne(childId),
    meta: {
      droppedSubjects: result.droppedSubjects,
      ...(result.qualifying ? { recommendationsPreview: await computeRecommendationsPreview(childId) } : {}),
    },
  }
}

// ---------- delete / reorder ----------

export async function deleteChild(ctx: ParentContext, childId: string) {
  await db.transaction().execute(async (trx) => {
    const existing = await repo.findChildRow(childId, trx)
    if (!existing) throw notFound('Child not found.')
    if (existing.parent_id !== ctx.parentId) throw forbidden("You can't do that.")
    // Join rows are left in place on purpose (harmless: every read goes through parent_children.deleted_at).
    await repo.softDeleteChild(trx, childId)
    await auditChange(trx, ctx, 'app.child_removed', childId, { childId })
  })
  await invalidateChildRecommendations(childId)
}

export async function reorderChildren(ctx: ParentContext, orderedIds: string[]) {
  await db.transaction().execute(async (trx) => {
    const live = await repo.listChildRows(ctx.parentId, trx)
    const liveIds = new Set(live.map((c) => c.id))
    if (orderedIds.some((id) => !liveIds.has(id))) throw forbidden("You can't do that.")

    // Listed children take the front positions in the order given; any not listed keep their relative order after.
    const finalOrder = [...orderedIds, ...live.map((c) => c.id).filter((id) => !orderedIds.includes(id))]
    const current = new Map(live.map((c) => [c.id, c.sort_order]))
    for (const [index, id] of finalOrder.entries()) {
      if (current.get(id) !== index) await repo.setSortOrder(trx, id, index)
    }
  })
}

async function auditChange(executor: Kysely<DB>, ctx: ParentContext, action: string, childId: string, details: Record<string, unknown>) {
  await audit(executor, {
    actorType: 'app_user',
    actorId: ctx.userId,
    action,
    module: 'app.children',
    entityType: 'parent_child',
    entityId: childId,
    newValues: details,
    ip: ctx.ip,
  })
}
