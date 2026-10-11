import { isDeepStrictEqual } from 'node:util'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { db } from '../../db/index.js'
import type { DB } from '../../db/types.js'
import { audit } from '../../lib/audit.js'
import { checkDeepLink } from '../../lib/deepLink.js'
import { ApiError, conflictState, forbidden, notFound, rateLimited, validationFailed } from '../../lib/errors.js'
import { readImageSize } from '../../lib/imageSize.js'
import { kvGet, kvSet } from '../../lib/kv.js'
import { cdnUrl } from '../../lib/present.js'
import { hitRateLimit } from '../../lib/rateLimit.js'
import { storage } from '../../lib/storage.js'
import type { Bucket } from '../../lib/storage.js'
import type { Ctx } from '../rbac/rbac.service.js'
import { PLACEMENTS, windowIssue } from './banners.schemas.js'
import type { CreateBannerInput, ListQuery, PatchBannerInput, PreviewQuery } from './banners.schemas.js'

export type { Ctx }

const NOT_FOUND = 'Banner not found.'
const STALE = 'Someone else changed this banner. Reload.'
const IMAGE_SIZE = { width: 1080, height: 480, tolerance: 2 }
const SERVE_LIMIT = 5
const SERVE_TTL_SECONDS = 300
const VERSION_KEY = 'banners:ver'
const EVENTS_PER_MINUTE = 60

const fieldError = (path: string, message: string) => validationFailed([{ path, message }], message)

type Row = {
  id: string
  title: string
  subtitle: string | null
  image_file_id: string
  placement: (typeof PLACEMENTS)[number]
  audience: 'all' | 'parents' | 'students' | 'teachers' | 'institutes'
  city_ids: string[]
  deep_link: string | null
  priority: number
  starts_at: Date
  ends_at: Date | null
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'expired'
  impressions: number | string
  clicks: number | string
  created_by: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
  image_key: string | null
  created_by_name: string | null
}

const SELECT = [
  'banners.id',
  'banners.title',
  'banners.subtitle',
  'banners.image_file_id',
  'banners.placement',
  'banners.audience',
  'banners.city_ids',
  'banners.deep_link',
  'banners.priority',
  'banners.starts_at',
  'banners.ends_at',
  'banners.status',
  'banners.impressions',
  'banners.clicks',
  'banners.created_by',
  'banners.created_at',
  'banners.updated_at',
  'banners.deleted_at',
  'files.object_key as image_key',
  'admins.full_name as created_by_name',
] as const

const baseQuery = (executor: Kysely<DB> = db) =>
  executor.selectFrom('banners').innerJoin('files', 'files.id', 'banners.image_file_id').leftJoin('admins', 'admins.id', 'banners.created_by').select(SELECT)

async function citiesFor(rows: Row[]) {
  const ids = [...new Set(rows.flatMap((r) => r.city_ids))]
  if (ids.length === 0) return new Map<string, string>()
  const found = await db.selectFrom('cities').select(['id', 'name']).where('id', 'in', ids).execute()
  return new Map(found.map((c) => [c.id, c.name]))
}

async function presentMany(rows: Row[]) {
  const names = await citiesFor(rows)
  return rows.map((r) => {
    const impressions = Number(r.impressions)
    const clicks = Number(r.clicks)
    return {
      id: r.id,
      status: r.status,
      title: r.title,
      subtitle: r.subtitle,
      image: { fileId: r.image_file_id, url: cdnUrl(r.image_key) },
      placement: r.placement,
      audience: r.audience,
      cities: r.city_ids.map((id) => ({ id, name: names.get(id) ?? 'Unknown city' })),
      deepLink: r.deep_link,
      priority: r.priority,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at ? r.ends_at.toISOString() : null,
      impressions,
      clicks,
      ctrPct: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : null,
      createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? 'Admin' } : null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    }
  })
}
export type BannerView = Awaited<ReturnType<typeof presentMany>>[number]

async function present(row: Row): Promise<BannerView> {
  return (await presentMany([row]))[0]!
}

async function loadRow(executor: Kysely<DB>, id: string, opts: { lock?: boolean; includeDeleted?: boolean } = {}): Promise<Row> {
  let q = baseQuery(executor).where('banners.id', '=', id)
  if (!opts.includeDeleted) q = q.where('banners.deleted_at', 'is', null)
  if (opts.lock) q = q.forUpdate('banners')
  const row = (await q.executeTakeFirst()) as Row | undefined
  if (!row) throw notFound(NOT_FOUND)
  return row
}

const auditBase = (ctx: Ctx, entityId: string) => ({
  actorType: 'admin' as const,
  actorId: ctx.actor.id,
  actorEmail: ctx.actor.email,
  module: 'banners',
  entityType: 'banners',
  entityId,
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  requestId: ctx.requestId,
})

// ------------------------------------------------------------------ serving cache (FR-44.2)

async function cacheVersion(): Promise<string> {
  return (await kvGet(VERSION_KEY)) ?? '0'
}

// Any banner change bumps the version, which orphans every cached (placement, audience, city) variant at once.
async function purgeCache(): Promise<void> {
  await kvSet(VERSION_KEY, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 30 * 86_400)
}

// ------------------------------------------------------------------ validation helpers

async function allowedDomains(): Promise<string[]> {
  const row = await db.selectFrom('system_settings').select('value').where('key', '=', 'banners.allowed_domains').executeTakeFirst()
  return Array.isArray(row?.value) ? (row.value as string[]) : []
}

async function checkLink(link: string | null | undefined) {
  if (!link) return
  if (!checkDeepLink(link, await allowedDomains()).ok) throw fieldError('deepLink', 'Use an app link or an approved website.')
}

// FR-44.4: an uploaded, public banner image of exactly 1080 x 480 px (+-2).
async function checkImage(fileId: string) {
  const file = await db
    .selectFrom('files')
    .select(['bucket', 'object_key', 'mime_type', 'size_bytes', 'purpose', 'status', 'visibility', 'uploaded_by_type', 'deleted_at'])
    .where('id', '=', fileId)
    .executeTakeFirst()
  const usable = file && file.deleted_at === null && file.status === 'uploaded' && file.visibility === 'public' && file.purpose === 'banner_image' && file.uploaded_by_type === 'admin' && file.mime_type.startsWith('image/')
  if (!usable) throw fieldError('imageFileId', 'Upload the banner image first.')
  const head = await storage.peek(file.bucket as Bucket, file.object_key, Math.min(Number(file.size_bytes), 600 * 1024))
  const size = head ? readImageSize(head) : null
  const close = (actual: number, wanted: number) => Math.abs(actual - wanted) <= IMAGE_SIZE.tolerance
  if (!size || !close(size.width, IMAGE_SIZE.width) || !close(size.height, IMAGE_SIZE.height)) {
    throw fieldError('imageFileId', 'Banner images must be 1080 × 480 px.')
  }
}

async function checkCities(ids: string[]) {
  if (ids.length === 0) return
  const found = await db.selectFrom('cities').select('id').where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
  if (found.length !== ids.length) throw fieldError('cityIds', 'Pick active cities from the list.')
}

// ------------------------------------------------------------------ reads

export async function listBanners(ctx: Ctx, query: ListQuery) {
  const includeDeleted = query.includeDeleted === true
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted banners.')

  const where = (eb: import('kysely').ExpressionBuilder<DB, 'banners'>) => {
    const conditions = []
    if (!includeDeleted) conditions.push(eb('banners.deleted_at', 'is', null))
    if (query.placement) conditions.push(eb('banners.placement', '=', query.placement))
    if (query.status) conditions.push(eb('banners.status', '=', query.status))
    if (query.audience) conditions.push(eb('banners.audience', '=', query.audience))
    if (query.cityId) conditions.push(sql<boolean>`(cardinality(banners.city_ids) = 0 or ${query.cityId}::uuid = any(banners.city_ids))`)
    if (query.q) conditions.push(sql<boolean>`banners.title ilike ${`%${query.q.replace(/[\\%_]/g, '\\$&')}%`}`)
    if (query.activeOn) {
      const dayStart = new Date(`${query.activeOn}T00:00:00+05:30`)
      const dayEnd = new Date(dayStart.getTime() + 86_400_000)
      conditions.push(eb('banners.status', '<>', 'draft'), eb('banners.starts_at', '<', dayEnd), eb.or([eb('banners.ends_at', 'is', null), eb('banners.ends_at', '>=', dayStart)]))
    }
    return eb.and(conditions)
  }

  const total = Number((await db.selectFrom('banners').select(sql<string>`count(*)`.as('n')).where(where).executeTakeFirstOrThrow()).n)

  const [field, dir] = (query.sort ?? 'priority:desc').split(':') as ['priority' | 'startsAt' | 'ctr', 'asc' | 'desc']
  let q = baseQuery().where(where)
  if (field === 'priority') q = q.orderBy('banners.placement').orderBy('banners.priority', dir).orderBy('banners.starts_at', 'desc')
  else if (field === 'startsAt') q = q.orderBy('banners.starts_at', dir)
  else q = q.orderBy(sql`banners.clicks::float8 / nullif(banners.impressions, 0)`, sql`${sql.raw(dir)} nulls last`).orderBy('banners.starts_at', 'desc')
  const rows = (await q.orderBy('banners.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize).execute()) as Row[]

  return {
    data: await presentMany(rows),
    meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  }
}

export async function getBanner(ctx: Ctx, id: string, includeDeleted = false) {
  if (includeDeleted && !ctx.actor.isSuperAdmin) throw forbidden('Only a Super Admin can see deleted banners.')
  return present(await loadRow(db, id, { includeDeleted }))
}

// ------------------------------------------------------------------ serving

type ServeInput = { placement: string; audience: string; cityId: string | null }

async function queryServing({ placement, audience, cityId }: ServeInput) {
  const now = new Date()
  const rows = await db
    .selectFrom('banners as b')
    .innerJoin('files as f', (join) => join.onRef('f.id', '=', 'b.image_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select(['b.id', 'b.title', 'b.subtitle', 'b.placement', 'b.deep_link', 'b.priority', 'f.object_key'])
    .where('b.status', '=', 'active')
    .where('b.deleted_at', 'is', null)
    .where('b.placement', '=', placement as never)
    .where('b.audience', 'in', ['all', audience] as never[])
    .where('b.starts_at', '<=', now)
    .where((eb) => eb.or([eb('b.ends_at', 'is', null), eb('b.ends_at', '>', now)]))
    .where(cityId ? sql<boolean>`(cardinality(b.city_ids) = 0 or ${cityId}::uuid = any(b.city_ids))` : sql<boolean>`cardinality(b.city_ids) = 0`)
    .orderBy('b.priority', 'desc')
    .orderBy('b.starts_at', 'desc')
    .limit(SERVE_LIMIT)
    .execute()
  return rows.map((r) => ({ id: r.id, title: r.title, subtitle: r.subtitle, imageUrl: cdnUrl(r.object_key), deepLink: r.deep_link, placement: r.placement, priority: r.priority }))
}

// What the mobile app gets (cached five minutes per placement, audience and city).
export async function serveBanners(input: ServeInput) {
  const key = `banners:serve:${await cacheVersion()}:${input.placement}:${input.audience}:${input.cityId ?? 'any'}`
  const hit = await kvGet(key)
  if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof queryServing>>
  const items = await queryServing(input)
  await kvSet(key, JSON.stringify(items), SERVE_TTL_SECONDS)
  return items
}

// Admin preview: the same rules, uncached, for every placement.
export async function previewBanners(query: PreviewQuery) {
  const entries = await Promise.all(PLACEMENTS.map(async (placement) => [placement, await queryServing({ placement, audience: query.audience, cityId: query.cityId ?? null })] as const))
  return { audience: query.audience, cityId: query.cityId ?? null, placements: Object.fromEntries(entries) }
}

// FR-44.3: the app batches impression/click events. Counters are bumped straight on the banner row (one update
// per banner per request), so there is no separate aggregation step to lag behind.
export async function recordEvents(ip: string | null, events: { bannerId: string; type: 'impression' | 'click' }[]) {
  const limit = await hitRateLimit(`banner-events:${ip ?? 'unknown'}`, EVENTS_PER_MINUTE, 60_000)
  if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds)
  const totals = new Map<string, { impressions: number; clicks: number }>()
  for (const e of events) {
    const t = totals.get(e.bannerId) ?? { impressions: 0, clicks: 0 }
    if (e.type === 'impression') t.impressions += 1
    else t.clicks += 1
    totals.set(e.bannerId, t)
  }
  let counted = 0
  for (const [id, t] of totals) {
    const res = await db
      .updateTable('banners')
      .set((eb) => ({ impressions: eb('impressions', '+', t.impressions), clicks: eb('clicks', '+', t.clicks) }))
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'paused', 'expired'])
      .executeTakeFirst()
    counted += Number(res.numUpdatedRows) === 1 ? t.impressions + t.clicks : 0
  }
  return { received: events.length, counted }
}

// ------------------------------------------------------------------ writes

export async function createBanner(ctx: Ctx, input: CreateBannerInput) {
  const startsAt = new Date(input.startsAt)
  const endsAt = input.endsAt ? new Date(input.endsAt) : null
  const issue = windowIssue(startsAt, endsAt)
  if (issue) throw fieldError('endsAt', issue)
  await checkImage(input.imageFileId)
  await checkCities(input.cityIds)
  await checkLink(input.deepLink)

  const view = await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('banners')
      .values({
        title: input.title,
        subtitle: input.subtitle ?? null,
        image_file_id: input.imageFileId,
        placement: input.placement,
        audience: input.audience,
        city_ids: sql`${input.cityIds}::uuid[]` as never,
        deep_link: input.deepLink ?? null,
        priority: input.priority,
        starts_at: startsAt,
        ends_at: endsAt,
        status: 'draft',
        created_by: ctx.actor.id,
        updated_by: ctx.actor.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const created = await present(await loadRow(trx, inserted.id))
    await audit(trx, { ...auditBase(ctx, inserted.id), action: 'banner.created', newValues: snapshot(created) })
    return created
  })
  await purgeCache()
  return view
}

// What goes into audit_logs: the editable fields, never counters or timestamps.
const snapshot = (b: BannerView) => ({
  title: b.title,
  subtitle: b.subtitle,
  imageFileId: b.image.fileId,
  placement: b.placement,
  audience: b.audience,
  cityIds: b.cities.map((c) => c.id),
  deepLink: b.deepLink,
  priority: b.priority,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
})

export async function patchBanner(ctx: Ctx, id: string, version: Date, input: PatchBannerInput) {
  // Anything that needs the outside world is checked before the transaction takes its row lock.
  const preview = await loadRow(db, id)
  if (input.imageFileId && input.imageFileId !== preview.image_file_id) await checkImage(input.imageFileId)
  if (input.cityIds) await checkCities(input.cityIds)
  if (input.deepLink !== undefined && input.deepLink !== preview.deep_link) await checkLink(input.deepLink)

  const view = await db.transaction().execute(async (trx) => {
    const row = await loadRow(trx, id, { lock: true })
    const before = await present(row)
    if (row.updated_at.getTime() !== version.getTime()) throw new ApiError(409, 'VERSION_CONFLICT', STALE, { current: before })
    if (row.status === 'expired') throw conflictState('This banner has ended. Create a new one.', { currentStatus: row.status })

    const wanted: Record<string, unknown> = { ...input }
    // The same instant can be written with different offsets, so compare instants, not text.
    if (input.startsAt) wanted.startsAt = new Date(input.startsAt).toISOString()
    if (input.endsAt) wanted.endsAt = new Date(input.endsAt).toISOString()
    const prior = snapshot(before) as Record<string, unknown>
    const changed = Object.keys(wanted).filter((k) => !isDeepStrictEqual(wanted[k], prior[k]))
    if (changed.length === 0) return before

    const startsAt = input.startsAt ? new Date(input.startsAt) : row.starts_at
    const endsAt = input.endsAt !== undefined ? (input.endsAt ? new Date(input.endsAt) : null) : row.ends_at
    const issue = windowIssue(startsAt, endsAt)
    if (issue) throw fieldError('endsAt', issue)
    if (row.status !== 'draft' && endsAt && endsAt <= new Date()) throw conflictState("This banner's end date has passed.", { currentStatus: row.status })

    const set: Record<string, unknown> = { updated_by: ctx.actor.id }
    if (input.title !== undefined) set.title = input.title
    if (input.subtitle !== undefined) set.subtitle = input.subtitle
    if (input.imageFileId !== undefined) set.image_file_id = input.imageFileId
    if (input.placement !== undefined) set.placement = input.placement
    if (input.audience !== undefined) set.audience = input.audience
    if (input.cityIds !== undefined) set.city_ids = sql`${input.cityIds}::uuid[]`
    if (input.deepLink !== undefined) set.deep_link = input.deepLink
    if (input.priority !== undefined) set.priority = input.priority
    if (input.startsAt !== undefined) set.starts_at = startsAt
    if (input.endsAt !== undefined) set.ends_at = endsAt
    await trx.updateTable('banners').set(set as never).where('id', '=', id).execute()

    const after = await present(await loadRow(trx, id))
    const next = snapshot(after) as Record<string, unknown>
    await audit(trx, {
      ...auditBase(ctx, id),
      action: 'banner.updated',
      oldValues: Object.fromEntries(changed.map((k) => [k, prior[k]])),
      newValues: Object.fromEntries(changed.map((k) => [k, next[k]])),
    })
    return after
  })
  await purgeCache()
  return view
}

type Transition = { action: 'banner.published' | 'banner.paused' | 'banner.resumed'; from: BannerView['status'][]; to: (row: Row, now: Date) => BannerView['status']; wrongState: string }

async function transition(ctx: Ctx, id: string, t: Transition) {
  const view = await db.transaction().execute(async (trx) => {
    const row = await loadRow(trx, id, { lock: true })
    if (!t.from.includes(row.status)) throw conflictState(t.wrongState, { currentStatus: row.status })
    const now = new Date()
    if (t.action !== 'banner.paused' && row.ends_at && row.ends_at <= now) throw conflictState("This banner's end date has passed.", { currentStatus: row.status })
    const status = t.to(row, now)
    await trx.updateTable('banners').set({ status, updated_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, id), action: t.action, oldValues: { status: row.status }, newValues: { status } })
    return present(await loadRow(trx, id))
  })
  await purgeCache()
  return view
}

const liveOrScheduled = (row: Row, now: Date) => (row.starts_at > now ? 'scheduled' : 'active')

export const publishBanner = (ctx: Ctx, id: string) =>
  transition(ctx, id, { action: 'banner.published', from: ['draft'], to: liveOrScheduled, wrongState: 'Only draft banners can be published.' })

export const pauseBanner = (ctx: Ctx, id: string) =>
  transition(ctx, id, { action: 'banner.paused', from: ['active'], to: () => 'paused', wrongState: 'Only active banners can be paused.' })

export const resumeBanner = (ctx: Ctx, id: string) =>
  transition(ctx, id, { action: 'banner.resumed', from: ['paused'], to: liveOrScheduled, wrongState: 'Only paused banners can be resumed.' })

// FR-44.6: the given order becomes the priority, highest first (100, 99, 98, ...).
export async function reorderBanners(ctx: Ctx, input: { placement: string; ids: string[] }) {
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('banners')
      .select(['id', 'placement'])
      .where('id', 'in', input.ids)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute()
    if (rows.length !== input.ids.length || rows.some((r) => r.placement !== input.placement)) {
      throw fieldError('ids', "Some of these banners aren't in this placement.")
    }
    for (const [index, id] of input.ids.entries()) {
      await trx.updateTable('banners').set({ priority: Math.max(0, 100 - index), updated_by: ctx.actor.id }).where('id', '=', id).execute()
    }
    await audit(trx, { ...auditBase(ctx, input.ids[0]!), entityId: null, action: 'banner.reordered', newValues: { placement: input.placement, order: input.ids } })
  })
  await purgeCache()
  return listBannersOfPlacement(input.placement)
}

async function listBannersOfPlacement(placement: string) {
  const rows = (await baseQuery().where('banners.deleted_at', 'is', null).where('banners.placement', '=', placement as never).orderBy('banners.priority', 'desc').orderBy('banners.starts_at', 'desc').execute()) as Row[]
  return presentMany(rows)
}

export async function deleteBanner(ctx: Ctx, id: string) {
  await db.transaction().execute(async (trx) => {
    const row = await loadRow(trx, id, { lock: true })
    if (row.status === 'active') throw conflictState('Pause the banner before deleting it.', { currentStatus: row.status })
    await trx.updateTable('banners').set({ deleted_at: new Date(), deleted_by: ctx.actor.id }).where('id', '=', id).execute()
    await audit(trx, { ...auditBase(ctx, id), action: 'banner.deleted', oldValues: { title: row.title, status: row.status } })
  })
  await purgeCache()
}

// ------------------------------------------------------------------ lifecycle job (FR-44.1)

// scheduled -> active at starts_at; scheduled/active -> expired at ends_at. Idempotent, so running it twice is harmless.
export async function runBannerLifecycle(now = new Date()) {
  const expired = await db
    .updateTable('banners')
    .set({ status: 'expired' })
    .where('deleted_at', 'is', null)
    .where('status', 'in', ['scheduled', 'active'])
    .where('ends_at', 'is not', null)
    .where('ends_at', '<=', now)
    .returning(['id', 'status'])
    .execute()
  const activated = await db
    .updateTable('banners')
    .set({ status: 'active' })
    .where('deleted_at', 'is', null)
    .where('status', '=', 'scheduled')
    .where('starts_at', '<=', now)
    .returning('id')
    .execute()
  for (const [action, rows] of [['banner.expired', expired], ['banner.activated', activated]] as const) {
    for (const r of rows) await audit(db, { actorType: 'system', action, module: 'banners', entityType: 'banners', entityId: r.id })
  }
  if (expired.length + activated.length > 0) await purgeCache()
  return { activated: activated.length, expired: expired.length }
}
