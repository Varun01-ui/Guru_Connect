import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, notFound, validationFailed } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { kvDel, kvGet, kvSet } from '../../lib/kv.js'
import type { Ctx } from '../rbac/rbac.service.js'
import { fieldsOf, feeSnapshot, loadVersion, present, resolvedPricing, versionsOfFee } from './pc.queries.js'
import type { Row } from './pc.queries.js'
import { LARGE_CHANGE_PERCENT, versionIssues } from './pc.rules.js'
import type { FeeCode, Issue, VersionFields } from './pc.rules.js'
import type { DraftInput } from './pc.schemas.js'

export type { Ctx }

const PRICING_CACHE_KEY = 'pricing:v1'
const PRICING_TTL_SECONDS = 60
const DRAFT_AUDIT_EVERY_SECONDS = 10 * 60
const MINUTE = 60_000

const issuesError = (issues: Issue[]) => validationFailed(issues, issues[0]!.message)
const fieldError = (path: string, message: string) => issuesError([{ path, message }])

export const purgePricingCache = () => kvDel(PRICING_CACHE_KEY)

// FR-5.12: what the app reads. Cached for a minute and purged on every publish, toggle, cancel and activation.
export async function getPublicPricing() {
  const hit = await kvGet(PRICING_CACHE_KEY)
  if (hit) return JSON.parse(hit) as Record<string, unknown>
  const data = await resolvedPricing()
  await kvSet(PRICING_CACHE_KEY, JSON.stringify(data), PRICING_TTL_SECONDS)
  return data
}

const auditBase = (ctx: Ctx, entityId: string) => ({
  actorType: 'admin' as const,
  actorId: ctx.actor.id,
  actorEmail: ctx.actor.email,
  module: 'payment_config',
  entityType: 'payment_configurations',
  entityId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  requestId: ctx.requestId,
})

// One fee changes at a time: the lock is held until the transaction ends. The unique indexes stay as the backstop.
async function lockFee(trx: Kysely<DB>, feeCode: string) {
  await sql`select pg_advisory_xact_lock(hashtext(${`payment_config:${feeCode}`}))`.execute(trx)
}

const snap = (f: VersionFields) => ({
  name: f.name,
  isEnabled: f.isEnabled,
  amountPaise: f.amountPaise,
  gstInclusive: f.gstInclusive,
  gstRateBps: f.gstRateBps,
  billingPeriod: f.billingPeriod,
  validityDays: f.validityDays,
  trialDays: f.trialDays,
})

type HistoryEntry = {
  configId: string
  feeCode: string
  action: 'published' | 'scheduled' | 'activated' | 'superseded' | 'cancelled' | 'enabled' | 'disabled'
  oldValues?: unknown
  newValues?: unknown
  reason?: string | null
  changedBy: string | null
}
async function addHistory(trx: Kysely<DB>, h: HistoryEntry) {
  await trx
    .insertInto('payment_configuration_history')
    .values({
      payment_configuration_id: h.configId,
      fee_code: h.feeCode,
      action: h.action,
      old_values: h.oldValues === undefined ? null : (JSON.stringify(h.oldValues) as never),
      new_values: h.newValues === undefined ? null : (JSON.stringify(h.newValues) as never),
      reason: h.reason ?? null,
      changed_by: h.changedBy,
    })
    .execute()
}

// The unique indexes make "two active versions" or "two drafts" impossible; losing that race is a plain conflict.
function mapRace(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string }
  if (err?.code === '23505' && err.constraint?.startsWith('uq_payment_config_')) {
    return new ApiError(409, 'VERSION_CONFLICT', 'Someone published a change just now. Reload.')
  }
  return e
}
const raceSafe = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (e) {
    throw mapRace(e)
  }
}

const dateText = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
const cancelFirst = (scheduled: Row) => conflictState(`Cancel the change scheduled for ${dateText(scheduled.effective_from)} first.`, { scheduledVersionId: scheduled.id })

// Version numbers count real versions only. A draft holds the number it will get (kept equal to the next free one),
// so publishing it later does not leave a hole.
async function nextVersion(trx: Kysely<DB>, feeCode: string): Promise<number> {
  const row = await trx.selectFrom('payment_configurations').select(sql<number>`coalesce(max(version), 0)`.as('v')).where('fee_code', '=', feeCode).where('status', '<>', 'draft').executeTakeFirstOrThrow()
  return Number(row.v) + 1
}

const columnsOf = (f: VersionFields) => ({
  name: f.name,
  description: f.description,
  is_enabled: f.isEnabled,
  amount_paise: f.amountPaise,
  gst_inclusive: f.gstInclusive,
  gst_rate_bps: f.gstRateBps,
  billing_period: f.billingPeriod,
  validity_days: f.validityDays,
  trial_days: f.trialDays,
})

const sameFields = (a: VersionFields, b: VersionFields) => JSON.stringify(snap(a)) === JSON.stringify(snap(b)) && a.description === b.description

// ---------------------------------------------------------------- drafts (FR-5.2)

export async function saveDraft(ctx: Ctx, feeCode: FeeCode, input: DraftInput, ifMatch: string | undefined) {
  type Saved = { row: Row; before: VersionFields | null; auditLater: boolean }
  const saved = await raceSafe(() =>
    db.transaction().execute(async (trx): Promise<Saved> => {
      await lockFee(trx, feeCode)
      const { active, draft } = await feeSnapshot(trx, feeCode)
      const latest = active ?? (await versionsOfFee(trx, feeCode))[0]
      const base = draft ?? latest
      if (!base) throw notFound('Fee not found.')

      if (draft) {
        const version = parseIfMatch(ifMatch)
        if (draft.updated_at.getTime() !== version.getTime()) {
          throw new ApiError(409, 'VERSION_CONFLICT', 'This draft changed in another tab.', { current: present(draft) })
        }
      }

      const before = fieldsOf(base)
      const merged: VersionFields = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
      const issues = versionIssues(feeCode, merged, false)
      if (issues.length > 0) throw issuesError(issues)

      if (!draft) {
        const inserted = await trx
          .insertInto('payment_configurations')
          .values({
            fee_code: feeCode,
            version: await nextVersion(trx, feeCode),
            ...columnsOf(merged),
            currency: base.currency,
            effective_from: new Date(),
            status: 'draft',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const row = await loadVersion(trx, inserted.id)
        await audit(trx, { ...auditBase(ctx, row.id), action: 'payment_config.draft_saved', newValues: { feeCode, version: row.version, changed: Object.keys(input) } })
        return { row, before: null, auditLater: false }
      }

      if (sameFields(before, merged)) return { row: draft, before: null, auditLater: false }
      await trx.updateTable('payment_configurations').set({ ...columnsOf(merged), updated_by: ctx.actor.id }).where('id', '=', draft.id).execute()
      return { row: await loadVersion(trx, draft.id), before, auditLater: true }
    }),
  )

  // Autosave fires every second while typing, so the audit trail gets one row per draft per ten minutes.
  if (saved.auditLater && saved.before) {
    const key = `pc:draft-audit:${saved.row.id}`
    if (!(await kvGet(key))) {
      await kvSet(key, '1', DRAFT_AUDIT_EVERY_SECONDS)
      const before = snap(saved.before)
      const after = snap(fieldsOf(saved.row))
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k])
      await audit(db, {
        ...auditBase(ctx, saved.row.id),
        action: 'payment_config.draft_saved',
        oldValues: Object.fromEntries(changed.map((k) => [k, before[k]])),
        newValues: { feeCode, version: saved.row.version, ...Object.fromEntries(changed.map((k) => [k, after[k]])) },
      })
    }
  }
  return present(saved.row)
}

export async function discardDraft(ctx: Ctx, feeCode: FeeCode) {
  await db.transaction().execute(async (trx) => {
    await lockFee(trx, feeCode)
    const { draft } = await feeSnapshot(trx, feeCode)
    if (!draft) throw conflictState("There's no draft to discard.")
    await trx.deleteFrom('payment_configurations').where('id', '=', draft.id).where('status', '=', 'draft').execute()
    await audit(trx, { ...auditBase(ctx, draft.id), action: 'payment_config.draft_discarded', oldValues: { feeCode, version: draft.version } })
  })
}

// ---------------------------------------------------------------- going live (FR-5.4, 5.5, 5.8)

type GoLive = {
  ctx: Ctx
  feeCode: FeeCode
  fields: VersionFields
  reason: string
  when: Date | null // null = now
  draft?: Row // publish: the draft row becomes the new version; otherwise a row is inserted
  history: 'published' | 'enabled' | 'disabled'
  auditAction: 'payment_config.published' | 'payment_config.toggled' | 'payment_config.restored'
  extra?: Record<string, unknown>
}

// Parse and range-check `effectiveFrom`; within a minute of now counts as "now".
export function resolveWhen(effectiveFrom: string | undefined, now = new Date()): Date | null {
  if (effectiveFrom === undefined) return null
  const at = new Date(effectiveFrom)
  if (at.getTime() < now.getTime() - MINUTE || at.getTime() > now.getTime() + 365 * 86_400_000) {
    throw fieldError('effectiveFrom', 'Pick a time from now up to one year ahead.')
  }
  return at.getTime() <= now.getTime() + MINUTE ? null : at
}

// FR-5.5 table of limits: a price may not move by more than 50% in one version without an explicit confirmation.
function largeChangeGuard(active: Row | undefined, fields: VersionFields, confirmed: boolean | undefined) {
  if (!active) return
  const before = Number(active.amount_paise)
  if (before <= 0 || confirmed) return
  const percent = (Math.abs(fields.amountPaise - before) / before) * 100
  if (percent > LARGE_CHANGE_PERCENT) {
    throw validationFailed([{ path: 'confirmLargeChange', message: `This is a ${Math.round(percent)}% change. Confirm it's intended.` }], `This is a ${Math.round(percent)}% change. Confirm it's intended.`)
  }
}

async function goLive(trx: Kysely<DB>, g: GoLive): Promise<Row> {
  const { active, scheduled } = await feeSnapshot(trx, g.feeCode)
  if (scheduled) throw cancelFirst(scheduled)
  const now = new Date()
  const version = await nextVersion(trx, g.feeCode)
  // A different draft is waiting: move it past the number this version is about to take.
  const waiting = g.draft ? undefined : (await feeSnapshot(trx, g.feeCode)).draft
  if (waiting) await trx.updateTable('payment_configurations').set({ version: version + 1 }).where('id', '=', waiting.id).execute()
  const status = g.when ? 'scheduled' : 'active'
  const effectiveFrom = g.when ?? now

  if (!g.when && active) {
    await trx.updateTable('payment_configurations').set({ status: 'superseded', effective_to: now, updated_by: g.ctx.actor.id }).where('id', '=', active.id).execute()
    await addHistory(trx, { configId: active.id, feeCode: g.feeCode, action: 'superseded', oldValues: { status: 'active' }, newValues: { status: 'superseded', effectiveTo: now.toISOString() }, changedBy: g.ctx.actor.id })
  }

  const live = {
    ...columnsOf(g.fields),
    version,
    status,
    effective_from: effectiveFrom,
    effective_to: null,
    change_reason: g.reason,
    published_by: g.ctx.actor.id,
    published_at: now,
    updated_by: g.ctx.actor.id,
  } as const
  let id: string
  if (g.draft) {
    await trx.updateTable('payment_configurations').set(live).where('id', '=', g.draft.id).execute()
    id = g.draft.id
  } else {
    id = (
      await trx
        .insertInto('payment_configurations')
        .values({ fee_code: g.feeCode, currency: active?.currency ?? 'INR', created_by: g.ctx.actor.id, ...live })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }

  const before = active ? snap(fieldsOf(active)) : null
  const after = snap(g.fields)
  await addHistory(trx, {
    configId: id,
    feeCode: g.feeCode,
    action: g.when ? 'scheduled' : g.history,
    oldValues: before,
    newValues: { ...after, version, effectiveFrom: effectiveFrom.toISOString(), ...g.extra },
    reason: g.reason,
    changedBy: g.ctx.actor.id,
  })
  await audit(trx, {
    ...auditBase(g.ctx, id),
    action: g.when ? 'payment_config.scheduled' : g.auditAction,
    oldValues: before ? { amountPaise: before.amountPaise, isEnabled: before.isEnabled } : null,
    newValues: { feeCode: g.feeCode, version, amountPaise: after.amountPaise, isEnabled: after.isEnabled, effectiveFrom: effectiveFrom.toISOString(), ...g.extra },
    reason: g.reason,
  })
  return loadVersion(trx, id)
}

export async function publishDraft(ctx: Ctx, feeCode: FeeCode, input: { effectiveFrom?: string; reason: string; confirmLargeChange?: boolean }) {
  const when = resolveWhen(input.effectiveFrom)
  const row = await raceSafe(() =>
    db.transaction().execute(async (trx) => {
      await lockFee(trx, feeCode)
      const { active, scheduled, draft } = await feeSnapshot(trx, feeCode)
      if (!draft) throw conflictState("There's no draft to publish.")
      if (scheduled) throw cancelFirst(scheduled)
      const fields = fieldsOf(draft)
      const issues = versionIssues(feeCode, fields, true)
      if (issues.length > 0) throw issuesError(issues)
      largeChangeGuard(active, fields, input.confirmLargeChange)
      return goLive(trx, { ctx, feeCode, fields, reason: input.reason, when, draft, history: 'published', auditAction: 'payment_config.published' })
    }),
  )
  await purgePricingCache()
  return snapshotView(feeCode, row)
}

export async function toggleFee(ctx: Ctx, feeCode: FeeCode, input: { enabled: boolean; reason: string }) {
  const row = await raceSafe(() =>
    db.transaction().execute(async (trx) => {
      await lockFee(trx, feeCode)
      const { active, scheduled } = await feeSnapshot(trx, feeCode)
      if (!active) throw conflictState('This fee has no live version to switch.')
      if (scheduled) throw cancelFirst(scheduled)
      if (active.is_enabled === input.enabled) throw conflictState(`This fee is already ${input.enabled ? 'on' : 'off'}.`, { isEnabled: active.is_enabled })
      const fields: VersionFields = { ...fieldsOf(active), isEnabled: input.enabled }
      const issues = input.enabled ? versionIssues(feeCode, fields, true) : []
      if (issues.length > 0) throw issuesError(issues)
      const live = await goLive(trx, { ctx, feeCode, fields, reason: input.reason, when: null, history: input.enabled ? 'enabled' : 'disabled', auditAction: 'payment_config.toggled' })
      return live
    }),
  )
  await purgePricingCache()
  return snapshotView(feeCode, row)
}

export async function restoreVersion(ctx: Ctx, versionId: string, input: { effectiveFrom?: string; reason: string; confirmLargeChange?: boolean }) {
  const when = resolveWhen(input.effectiveFrom)
  const source = await loadVersion(db, versionId)
  const feeCode = source.fee_code as FeeCode
  if (source.status === 'draft') throw conflictState("A draft can't be restored. Publish it instead.", { currentStatus: source.status })

  const row = await raceSafe(() =>
    db.transaction().execute(async (trx) => {
      await lockFee(trx, feeCode)
      const { active, scheduled } = await feeSnapshot(trx, feeCode)
      if (scheduled) throw cancelFirst(scheduled)
      const fields = fieldsOf(source)
      if (active && !when && sameFields(fieldsOf(active), fields)) throw conflictState('That is already the current version.')
      const issues = versionIssues(feeCode, fields, true)
      if (issues.length > 0) throw issuesError(issues)
      largeChangeGuard(active, fields, input.confirmLargeChange)
      return goLive(trx, { ctx, feeCode, fields, reason: input.reason, when, history: 'published', auditAction: 'payment_config.restored', extra: { restoredFromVersion: source.version } })
    }),
  )
  await purgePricingCache()
  return snapshotView(feeCode, row)
}

// FR-5.7
export async function cancelScheduled(ctx: Ctx, versionId: string, reason: string) {
  const found = await loadVersion(db, versionId)
  const feeCode = found.fee_code as FeeCode
  await db.transaction().execute(async (trx) => {
    await lockFee(trx, feeCode)
    const row = await loadVersion(trx, versionId, true)
    if (row.status !== 'scheduled') throw conflictState('Only scheduled changes can be cancelled.', { currentStatus: row.status })
    await trx.updateTable('payment_configurations').set({ status: 'cancelled', updated_by: ctx.actor.id }).where('id', '=', versionId).execute()
    await addHistory(trx, { configId: versionId, feeCode, action: 'cancelled', oldValues: { status: 'scheduled' }, newValues: { status: 'cancelled', version: row.version }, reason, changedBy: ctx.actor.id })
    await audit(trx, { ...auditBase(ctx, versionId), action: 'payment_config.schedule_cancelled', newValues: { feeCode, version: row.version }, reason })
  })
  await purgePricingCache()
  return snapshotView(feeCode, await loadVersion(db, versionId))
}

async function snapshotView(feeCode: string, changed: Row) {
  const { active, scheduled, draft } = await feeSnapshot(db, feeCode)
  return { feeCode, changed: present(changed), active: active ? present(active) : null, scheduled: scheduled ? present(scheduled) : null, draft: draft ? present(draft) : null }
}

// ---------------------------------------------------------------- scheduler (FR-5.6)

// Every minute: scheduled versions whose time has come replace the active one. Idempotent; a version another worker
// holds is skipped (FOR UPDATE SKIP LOCKED) and picked up by whichever run gets the lock.
export async function activateDueVersions(now = new Date()): Promise<number> {
  const due = await db.selectFrom('payment_configurations').select(['id', 'fee_code']).where('status', '=', 'scheduled').where('effective_from', '<=', now).orderBy('effective_from').execute()
  let activated = 0
  for (const candidate of due) {
    const done = await db.transaction().execute(async (trx) => {
      await lockFee(trx, candidate.fee_code)
      const row = await trx
        .selectFrom('payment_configurations')
        .select(['id', 'fee_code', 'version', 'effective_from', 'amount_paise', 'is_enabled'])
        .where('id', '=', candidate.id)
        .where('status', '=', 'scheduled')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (!row) return false

      const { active } = await feeSnapshot(trx, row.fee_code)
      if (active) {
        // Keep the windows contiguous: the old version ends exactly where the new one begins.
        const endsAt = row.effective_from.getTime() > active.effective_from.getTime() ? row.effective_from : new Date(active.effective_from.getTime() + 1)
        await trx.updateTable('payment_configurations').set({ status: 'superseded', effective_to: endsAt }).where('id', '=', active.id).execute()
        await addHistory(trx, { configId: active.id, feeCode: row.fee_code, action: 'superseded', oldValues: { status: 'active' }, newValues: { status: 'superseded', effectiveTo: endsAt.toISOString() }, changedBy: null })
      }
      await trx.updateTable('payment_configurations').set({ status: 'active' }).where('id', '=', row.id).execute()
      await addHistory(trx, { configId: row.id, feeCode: row.fee_code, action: 'activated', oldValues: { status: 'scheduled' }, newValues: { status: 'active', version: row.version }, changedBy: null })
      await audit(trx, {
        actorType: 'system',
        action: 'payment_config.activated',
        module: 'payment_config',
        entityType: 'payment_configurations',
        entityId: row.id,
        newValues: { feeCode: row.fee_code, version: row.version, amountPaise: Number(row.amount_paise), isEnabled: row.is_enabled },
      })
      return true
    })
    if (done) activated += 1
  }
  if (activated > 0) await purgePricingCache()
  return activated
}
