import { sql } from 'kysely'
import type { z } from 'zod'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { conflictState, notFound, validationFailed } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { shortName } from '../../../lib/names.js'
import { createNotification } from '../../../lib/notify.js'
import type { TeacherContext } from '../teacher/teacher.service.js'
import { minutesOf } from './availability.schemas.js'
import type { createTimeOffSchema, setAvailabilitySchema } from './availability.schemas.js'

const DAY_MS = 86_400_000
const IST_OFFSET_MS = 5.5 * 3_600_000
const MAX_ACTIVE_TIME_OFF = 10
const CLASH_CANCEL_REASON = 'Teacher marked this period as time off'

const fieldError = (path: string, message: string, extra: Record<string, unknown> = {}) => validationFailed([{ path, message, ...extra }], message)

// The API speaks 0 = Sunday ... 6 = Saturday; the table stores ISO days (1 = Monday ... 7 = Sunday).
const toDbDay = (d: number) => (d === 0 ? 7 : d)
const toApiDay = (d: number) => (d === 7 ? 0 : d)

export const istToday = (now = new Date()): string => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS)
const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
// Start of an IST calendar day as an instant.
const istDayStart = (isoDate: string) => new Date(Date.parse(`${isoDate}T00:00:00Z`) - IST_OFFSET_MS)

const hhmm = (t: string) => t.slice(0, 5)

// ---- reads ----

export async function listWindows(teacherId: string, executor = db) {
  const rows = await executor
    .selectFrom('teacher_availability as a')
    .leftJoin('teaching_modes as m', 'm.id', 'a.teaching_mode_id')
    .select(['a.id', 'a.day_of_week', 'a.start_time', 'a.end_time', 'a.accepts_demos', 'a.teaching_mode_id', 'm.name as mode_name'])
    .where('a.teacher_id', '=', teacherId)
    .where('a.deleted_at', 'is', null)
    .orderBy('a.day_of_week')
    .orderBy('a.start_time')
    .execute()
  return rows
    .map((r) => ({ id: r.id, dayOfWeek: toApiDay(r.day_of_week), startTime: hhmm(r.start_time), endTime: hhmm(r.end_time), teachingModeId: r.teaching_mode_id, teachingMode: r.mode_name, acceptsDemos: r.accepts_demos }))
}

// Active = not yet over (the range's last day is today or later).
export async function listTimeOff(teacherId: string, executor = db) {
  const rows = await executor
    .selectFrom('teacher_time_off')
    .select(['id', sql<string>`starts_on::text`.as('starts_on'), sql<string>`ends_on::text`.as('ends_on'), 'reason', 'pause_leads'])
    .where('teacher_id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`ends_on >= ${istToday()}::date`)
    .orderBy('starts_on')
    .execute()
  return rows.map((r) => ({ id: r.id, startsOn: r.starts_on, endsOn: r.ends_on, reason: r.reason, pauseLeads: r.pause_leads }))
}

export async function getAvailability(teacherId: string) {
  const [windows, timeOff] = await Promise.all([listWindows(teacherId), listTimeOff(teacherId)])
  return { windows, timeOff }
}

// HOOK for Modules 27/37/38: is the teacher currently away with leads paused (BR-19.4)?
export async function pausedUntil(teacherId: string, now = new Date()): Promise<string | null> {
  const today = istToday(now)
  const row = await db
    .selectFrom('teacher_time_off')
    .select(sql<string>`ends_on::text`.as('ends_on'))
    .where('teacher_id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .where('pause_leads', '=', true)
    .where(sql<boolean>`starts_on <= ${today}::date and ends_on >= ${today}::date`)
    .orderBy('ends_on', 'desc')
    .executeTakeFirst()
  return row?.ends_on ?? null
}

// ---- PUT /teacher/availability (BR-19.1) ----

export async function setAvailability(ctx: TeacherContext, body: z.infer<typeof setAvailabilitySchema>) {
  const items = body.items.map((i) => ({ day: toDbDay(i.dayOfWeek), start: i.startTime, end: i.endTime, modeId: i.teachingModeId ?? null, acceptsDemos: i.acceptsDemos }))

  // 0-5 windows a day, no overlap on the same day whatever the mode (one person, one place at a time).
  const byDay = new Map<number, typeof items>()
  for (const i of items) byDay.set(i.day, [...(byDay.get(i.day) ?? []), i])
  for (const [day, list] of byDay) {
    if (list.length > 5) throw fieldError('items', 'Up to 5 windows per day', { reason: 'max_windows_per_day', dayOfWeek: toApiDay(day) })
    const sorted = [...list].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
    for (let k = 1; k < sorted.length; k++) {
      if (minutesOf(sorted[k]!.start) < minutesOf(sorted[k - 1]!.end)) throw fieldError('items', 'This overlaps another window on the same day', { dayOfWeek: toApiDay(day) })
    }
  }

  return db.transaction().execute(async (trx) => {
    const modeIds = [...new Set(items.map((i) => i.modeId).filter((m): m is string => m !== null))]
    if (modeIds.length) {
      const own = await trx.selectFrom('teacher_teaching_modes').select('teaching_mode_id').where('teacher_id', '=', ctx.teacherId).where('teaching_mode_id', 'in', modeIds).execute()
      if (own.length !== modeIds.length) throw fieldError('items', 'Choose one of your own teaching modes.')
    }

    const existing = await trx.selectFrom('teacher_availability').select(['id', 'day_of_week', 'start_time', 'end_time']).where('teacher_id', '=', ctx.teacherId).where('deleted_at', 'is', null).execute()
    const key = (day: number, start: string, end: string) => `${day}|${hhmm(start)}|${hhmm(end)}`
    const wanted = new Set(items.map((i) => key(i.day, i.start, i.end)))
    const byKey = new Map(existing.map((e) => [key(e.day_of_week, e.start_time, e.end_time), e.id]))

    const removed = existing.filter((e) => !wanted.has(key(e.day_of_week, e.start_time, e.end_time))).map((e) => e.id)
    if (removed.length) await trx.updateTable('teacher_availability').set({ deleted_at: new Date() }).where('id', 'in', removed).execute()
    for (const i of items) {
      const id = byKey.get(key(i.day, i.start, i.end))
      if (id) await trx.updateTable('teacher_availability').set({ teaching_mode_id: i.modeId, accepts_demos: i.acceptsDemos }).where('id', '=', id).execute()
      else await trx.insertInto('teacher_availability').values({ teacher_id: ctx.teacherId, day_of_week: i.day, start_time: i.start, end_time: i.end, teaching_mode_id: i.modeId, accepts_demos: i.acceptsDemos }).execute()
    }

    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_availability_set',
      module: 'app.teacher_availability',
      entityType: 'teacher',
      entityId: ctx.teacherId,
      newValues: { windowCount: items.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    return getAvailabilityTx(trx, ctx.teacherId)
  })
}

async function getAvailabilityTx(trx: Parameters<typeof listWindows>[1], teacherId: string) {
  return { windows: await listWindows(teacherId, trx), timeOff: await listTimeOff(teacherId, trx) }
}

// ---- POST /teacher/time-off (BR-19.2, BR-19.3) ----

type CreateTimeOffBody = z.infer<typeof createTimeOffSchema>

export async function createTimeOff(ctx: TeacherContext, body: CreateTimeOffBody, idempotencyKey: string | undefined) {
  const cacheKey = idempotencyKey ? `toff:${ctx.teacherId}:${idempotencyKey}` : null
  if (cacheKey) {
    const cached = await getIdempotent(cacheKey)
    if (cached) return cached.body as TimeOffResult
  }

  const today = istToday()
  if (body.endsOn < body.startsOn) throw fieldError('endsOn', 'End date must be on or after the start date')
  if (body.startsOn < today) throw fieldError('startsOn', 'Pick a range up to 90 days', { reason: 'starts_in_past' })
  if (dayNumber(body.endsOn) - dayNumber(body.startsOn) > 90) throw fieldError('endsOn', 'Pick a range up to 90 days')

  const result = await db.transaction().execute(async (trx) => {
    // Serialises concurrent adds for one teacher so the 10-range cap and overlap rule cannot be raced.
    await sql`select pg_advisory_xact_lock(hashtext(${`timeoff:${ctx.teacherId}`}))`.execute(trx)

    const active = await trx
      .selectFrom('teacher_time_off')
      .select(['id', sql<string>`starts_on::text`.as('starts_on'), sql<string>`ends_on::text`.as('ends_on')])
      .where('teacher_id', '=', ctx.teacherId)
      .where('deleted_at', 'is', null)
      .where(sql<boolean>`ends_on >= ${today}::date`)
      .execute()
    if (active.some((r) => r.starts_on <= body.endsOn && r.ends_on >= body.startsOn)) throw fieldError('startsOn', 'You already have time off marked for these dates')
    if (active.length >= MAX_ACTIVE_TIME_OFF) throw fieldError('startsOn', 'Remove an old range first', { reason: 'max_time_off' })

    // Demos inside [startsOn 00:00 IST, endsOn 23:59 IST] (BR-19.3).
    const from = istDayStart(body.startsOn)
    const to = istDayStart(addDays(body.endsOn, 1))
    const clashes = await trx
      .selectFrom('demo_requests as d')
      .innerJoin('app_users as u', 'u.id', 'd.requester_user_id')
      .select(['d.id', 'd.requester_user_id', 'u.full_name', sql<Date>`coalesce(d.confirmed_start_at, d.requested_start_at)`.as('start_at')])
      .where('d.teacher_id', '=', ctx.teacherId)
      .where('d.status', 'in', ['requested', 'confirmed', 'reschedule_proposed'])
      .where(sql<boolean>`coalesce(d.confirmed_start_at, d.requested_start_at) >= ${from} and coalesce(d.confirmed_start_at, d.requested_start_at) < ${to}`)
      .orderBy(sql`coalesce(d.confirmed_start_at, d.requested_start_at)`)
      .forUpdate('d')
      .execute()

    if (clashes.length > 0 && !body.confirmForce) {
      throw conflictState('You have demos scheduled during this time.', { affectedDemos: clashes.map((c) => ({ demoId: c.id, requesterName: shortName(c.full_name), startAt: new Date(c.start_at).toISOString() })) })
    }

    const row = await trx
      .insertInto('teacher_time_off')
      .values({ teacher_id: ctx.teacherId, starts_on: body.startsOn, ends_on: body.endsOn, reason: body.reason?.trim() || null, pause_leads: body.pauseLeads })
      .returning('id')
      .executeTakeFirstOrThrow()

    if (clashes.length > 0) {
      await trx
        .updateTable('demo_requests')
        .set({ status: 'cancelled', cancelled_by: 'teacher', cancel_reason: CLASH_CANCEL_REASON })
        .where('id', 'in', clashes.map((c) => c.id))
        .execute()
      const teacher = await trx.selectFrom('teachers').select('full_name').where('id', '=', ctx.teacherId).executeTakeFirstOrThrow()
      for (const c of clashes) {
        // The underlying lead is left open: a cancelled demo does not close the enquiry.
        await createNotification(trx, {
          userId: c.requester_user_id,
          category: 'demos',
          eventType: 'demo.cancelled_by_teacher',
          title: 'Your demo was cancelled',
          body: `${teacher.full_name} marked this time as unavailable. Find another slot or teacher.`,
          deepLink: `gc://demos/${c.id}`,
          data: { demoId: c.id },
          dedupeKey: `demo.cancelled_by_teacher:${c.id}`,
        })
      }
    }

    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_time_off_added',
      module: 'app.teacher_availability',
      entityType: 'teacher_time_off',
      entityId: row.id,
      newValues: { startsOn: body.startsOn, endsOn: body.endsOn, pauseLeads: body.pauseLeads, cancelledDemoCount: clashes.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    return { id: row.id, startsOn: body.startsOn, endsOn: body.endsOn, reason: body.reason?.trim() || null, pauseLeads: body.pauseLeads, cancelledDemoCount: clashes.length }
  })

  if (cacheKey) await putIdempotent(cacheKey, 201, result)
  return result
}
type TimeOffResult = { id: string; startsOn: string; endsOn: string; reason: string | null; pauseLeads: boolean; cancelledDemoCount: number }

// ---- DELETE /teacher/time-off/:id (BR-19.5) ----

export async function deleteTimeOff(ctx: TeacherContext, id: string) {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('teacher_time_off')
      .select(['id', sql<string>`starts_on::text`.as('starts_on'), sql<string>`ends_on::text`.as('ends_on')])
      .where('id', '=', id)
      .where('teacher_id', '=', ctx.teacherId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!row) throw notFound('This is no longer available.')
    // Nothing references a time-off row, so it is removed outright. Demos cancelled by it earlier stay cancelled.
    await trx.deleteFrom('teacher_time_off').where('id', '=', id).execute()
    await audit(trx, {
      actorType: 'app_user',
      actorId: ctx.userId,
      action: 'app.teacher_time_off_removed',
      module: 'app.teacher_availability',
      entityType: 'teacher_time_off',
      entityId: id,
      newValues: { startsOn: row.starts_on, endsOn: row.ends_on },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
  })
}
