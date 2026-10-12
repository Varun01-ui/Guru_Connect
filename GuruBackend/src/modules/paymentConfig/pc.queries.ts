import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { conflictState, notFound, validationFailed } from '../../lib/errors.js'
import { FEE_CODES, formatRupees, isFeeCode, priceCard } from './pc.rules.js'
import type { BillingPeriod, FeeCode, VersionFields } from './pc.rules.js'
import type { HistoryQuery, VersionsQuery } from './pc.schemas.js'

export type Row = {
  id: string
  fee_code: string
  version: number
  name: string
  description: string | null
  is_enabled: boolean
  amount_paise: number | string
  currency: string
  gst_inclusive: boolean
  gst_rate_bps: number
  billing_period: string
  validity_days: number | null
  trial_days: number
  effective_from: Date
  effective_to: Date | null
  status: 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled'
  change_reason: string | null
  published_by: string | null
  published_at: Date | null
  created_by: string | null
  updated_at: Date
  created_at: Date
  published_by_name: string | null
}

const SELECT = [
  'payment_configurations.id',
  'payment_configurations.fee_code',
  'payment_configurations.version',
  'payment_configurations.name',
  'payment_configurations.description',
  'payment_configurations.is_enabled',
  'payment_configurations.amount_paise',
  'payment_configurations.currency',
  'payment_configurations.gst_inclusive',
  'payment_configurations.gst_rate_bps',
  'payment_configurations.billing_period',
  'payment_configurations.validity_days',
  'payment_configurations.trial_days',
  'payment_configurations.effective_from',
  'payment_configurations.effective_to',
  'payment_configurations.status',
  'payment_configurations.change_reason',
  'payment_configurations.published_by',
  'payment_configurations.published_at',
  'payment_configurations.created_by',
  'payment_configurations.updated_at',
  'payment_configurations.created_at',
  'admins.full_name as published_by_name',
] as const

export const versionQuery = (executor: Kysely<DB> = db) =>
  executor.selectFrom('payment_configurations').leftJoin('admins', 'admins.id', 'payment_configurations.published_by').select(SELECT)

export function present(r: Row) {
  return {
    id: r.id,
    feeCode: r.fee_code,
    version: r.version,
    name: r.name,
    description: r.description,
    isEnabled: r.is_enabled,
    amountPaise: Number(r.amount_paise),
    currency: r.currency.trim(),
    gstInclusive: r.gst_inclusive,
    gstRateBps: r.gst_rate_bps,
    billingPeriod: r.billing_period as BillingPeriod,
    validityDays: r.validity_days,
    trialDays: r.trial_days,
    status: r.status,
    effectiveFrom: r.effective_from.toISOString(),
    effectiveTo: r.effective_to ? r.effective_to.toISOString() : null,
    changeReason: r.change_reason,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    publishedBy: r.published_by ? { id: r.published_by, name: r.published_by_name ?? 'Admin' } : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}
export type VersionView = ReturnType<typeof present>

export const fieldsOf = (r: Row | VersionView): VersionFields => {
  const v = 'is_enabled' in r ? present(r) : r
  return {
    name: v.name,
    description: v.description,
    isEnabled: v.isEnabled,
    amountPaise: v.amountPaise,
    gstInclusive: v.gstInclusive,
    gstRateBps: v.gstRateBps,
    billingPeriod: v.billingPeriod,
    validityDays: v.validityDays,
    trialDays: v.trialDays,
  }
}

export function assertFeeCode(value: string): FeeCode {
  if (!isFeeCode(value)) throw notFound('Fee not found.')
  return value
}

export async function loadVersion(executor: Kysely<DB>, id: string, lock = false): Promise<Row> {
  let q = versionQuery(executor).where('payment_configurations.id', '=', id)
  if (lock) q = q.forUpdate('payment_configurations')
  const row = (await q.executeTakeFirst()) as Row | undefined
  if (!row) throw notFound('Version not found.')
  return row
}

export async function versionsOfFee(executor: Kysely<DB>, feeCode: string, statuses?: string[]): Promise<Row[]> {
  let q = versionQuery(executor).where('payment_configurations.fee_code', '=', feeCode)
  if (statuses) q = q.where('payment_configurations.status', 'in', statuses as never[])
  return (await q.orderBy('payment_configurations.version', 'desc').execute()) as Row[]
}

// The current picture of one fee: what is live, what is coming and what is being prepared.
export async function feeSnapshot(executor: Kysely<DB>, feeCode: string) {
  const rows = await versionsOfFee(executor, feeCode, ['active', 'scheduled', 'draft'])
  const pick = (status: string) => rows.find((r) => r.status === status)
  return { active: pick('active'), scheduled: pick('scheduled'), draft: pick('draft') }
}

// ---------------------------------------------------------------- GET /payment-configs

export async function usage30d() {
  const since = new Date(Date.now() - 30 * 86_400_000)
  const rows = await db
    .selectFrom('transactions')
    .select(['fee_code', sql<string>`count(*)`.as('captured'), sql<string>`coalesce(sum(amount_paise), 0)`.as('revenue')])
    .where('status', 'in', ['captured', 'refund_pending', 'partially_refunded'])
    .where('direction', '=', 'credit')
    .where('captured_at', '>=', since)
    .where('fee_code', 'is not', null)
    .groupBy('fee_code')
    .execute()
  return new Map(rows.map((r) => [r.fee_code!, { captured: Number(r.captured), revenuePaise: Number(r.revenue) }]))
}

const brief = (r: Row | undefined) => (r ? present(r) : null)

export async function listFees() {
  const rows = (await versionQuery().where('payment_configurations.status', 'in', ['active', 'scheduled', 'draft']).execute()) as Row[]
  const usage = await usage30d()
  return FEE_CODES.map((feeCode) => {
    const mine = rows.filter((r) => r.fee_code === feeCode)
    const pick = (status: string) => brief(mine.find((r) => r.status === status))
    return {
      feeCode,
      active: pick('active'),
      scheduled: pick('scheduled'),
      draft: pick('draft'),
      usage30d: usage.get(feeCode) ?? { captured: 0, revenuePaise: 0 },
    }
  })
}

// ---------------------------------------------------------------- GET /payment-configs/:feeCode

export async function getFee(feeCode: string, query: VersionsQuery) {
  const code = assertFeeCode(feeCode)
  const snapshot = await feeSnapshot(db, code)
  let countQuery = db.selectFrom('payment_configurations').select(sql<string>`count(*)`.as('n')).where('fee_code', '=', code)
  if (query.status) countQuery = countQuery.where('status', '=', query.status)
  const total = Number((await countQuery.executeTakeFirstOrThrow()).n)
  let listQuery = versionQuery().where('payment_configurations.fee_code', '=', code)
  if (query.status) listQuery = listQuery.where('payment_configurations.status', '=', query.status)
  const versions = (await listQuery
    .orderBy('payment_configurations.version', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute()) as Row[]
  const usage = await usage30d()
  return {
    data: {
      feeCode: code,
      active: brief(snapshot.active),
      scheduled: brief(snapshot.scheduled),
      draft: brief(snapshot.draft),
      usage30d: usage.get(code) ?? { captured: 0, revenuePaise: 0 },
      versions: versions.map(present),
    },
    meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  }
}

// ---------------------------------------------------------------- preview (FR-5.3)

export async function previewDraft(feeCode: string) {
  const code = assertFeeCode(feeCode)
  const { active, draft } = await feeSnapshot(db, code)
  if (!draft) throw conflictState("There's no draft to preview.")
  const now = new Date()
  const liveSubs = active
    ? Number(
        (
          await db
            .selectFrom('subscriptions')
            .select(sql<string>`count(*)`.as('n'))
            .where('payment_configuration_id', '=', active.id)
            .where('status', 'in', ['trial', 'active', 'grace'])
            .executeTakeFirstOrThrow()
        ).n,
      )
    : 0
  const openCheckouts = Number(
    (
      await db
        .selectFrom('transactions')
        .select(sql<string>`count(*)`.as('n'))
        .where('fee_code', '=', code)
        .where('status', '=', 'created')
        .where('created_at', '>', new Date(now.getTime() - 30 * 60_000))
        .executeTakeFirstOrThrow()
    ).n,
  )
  const before = active ? Number(active.amount_paise) : 0
  const after = Number(draft.amount_paise)
  return {
    card: priceCard(fieldsOf(draft)),
    impact: {
      liveSubscriptionsOnCurrentVersion: liveSubs,
      openCheckouts,
      changePercent: before > 0 ? Math.round(((after - before) / before) * 1000) / 10 : null,
    },
  }
}


// ---------------------------------------------------------------- history (cursor, 50)

// The timestamp travels as PostgreSQL's own text (microseconds): a JS Date would cut it to milliseconds and rows
// sharing a timestamp could be skipped between pages.
const encodeCursor = (createdAt: string, id: string) => Buffer.from(`${createdAt}|${id}`).toString('base64url')
function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|')
    if (!at || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/.test(at) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad')
    return { at, id }
  } catch {
    throw validationFailed([{ path: 'cursor', message: 'That page link is no longer valid.' }])
  }
}

export async function listHistory(query: HistoryQuery) {
  if (query.feeCode && !isFeeCode(query.feeCode)) throw validationFailed([{ path: 'feeCode', message: 'Unknown fee.' }])
  let q = db
    .selectFrom('payment_configuration_history as h')
    .innerJoin('payment_configurations as c', 'c.id', 'h.payment_configuration_id')
    .leftJoin('admins as a', 'a.id', 'h.changed_by')
    .select(['h.id', 'h.fee_code', 'h.action', 'h.old_values', 'h.new_values', 'h.reason', 'h.changed_by', 'h.created_at', 'h.payment_configuration_id', 'c.version', 'a.full_name as changed_by_name', sql<string>`h.created_at::text`.as('created_at_text')])
  if (query.feeCode) q = q.where('h.fee_code', '=', query.feeCode)
  if (query.action) q = q.where('h.action', '=', query.action)
  if (query.adminId) q = q.where('h.changed_by', '=', query.adminId)
  if (query.from) q = q.where('h.created_at', '>=', new Date(query.from))
  if (query.to) q = q.where('h.created_at', '<=', new Date(query.to))
  if (query.cursor) {
    const { at, id } = decodeCursor(query.cursor)
    q = q.where(sql<boolean>`(h.created_at, h.id) < (${at}::timestamptz, ${id}::uuid)`)
  }
  const rows = await q.orderBy('h.created_at', 'desc').orderBy('h.id', 'desc').limit(query.limit + 1).execute()
  const page = rows.slice(0, query.limit)
  const last = page[page.length - 1]
  return {
    data: page.map((h) => ({
      id: h.id,
      feeCode: h.fee_code,
      action: h.action,
      versionId: h.payment_configuration_id,
      version: h.version,
      oldValues: h.old_values,
      newValues: h.new_values,
      reason: h.reason,
      changedBy: h.changed_by ? { id: h.changed_by, name: h.changed_by_name ?? 'Admin' } : null,
      createdAt: h.created_at.toISOString(),
    })),
    meta: { limit: query.limit, nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at_text, last.id) : null },
  }
}

// ---------------------------------------------------------------- public pricing (FR-5.12)

export async function resolvedPricing() {
  const now = new Date()
  const rows = (await versionQuery()
    .where('payment_configurations.status', 'in', ['active', 'scheduled'])
    .where('payment_configurations.effective_from', '<=', now)
    .where((eb) => eb.or([eb('payment_configurations.effective_to', 'is', null), eb('payment_configurations.effective_to', '>', now)]))
    .orderBy('payment_configurations.effective_from', 'desc')
    .execute()) as Row[]
  const data: Record<string, unknown> = {}
  for (const feeCode of FEE_CODES) {
    const row = rows.find((r) => r.fee_code === feeCode) // newest first, same rule as resolveFee()
    if (!row || !row.is_enabled) {
      data[feeCode] = { enabled: false }
      continue
    }
    data[feeCode] = {
      enabled: true,
      amountPaise: Number(row.amount_paise),
      currency: row.currency.trim(),
      billingPeriod: row.billing_period,
      validityDays: row.validity_days,
      trialDays: row.trial_days,
      gstInclusive: row.gst_inclusive,
      gstRateBps: row.gst_rate_bps,
      name: row.name,
      description: row.description,
      versionId: row.id,
    }
  }
  return data
}

export { formatRupees }
