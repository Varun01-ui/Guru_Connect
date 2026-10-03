import { sql } from 'kysely'
import { db } from '../../../db/index.js'
import { notFound } from '../../../lib/errors.js'
import { kvGet } from '../../../lib/kv.js'
import { coldStartKey } from '../student/student.service.js'
import { banners } from './home.service.js'
import { loadRail, RAIL_CODES } from './home.rails.js'
import type { RailCode } from './home.rails.js'
import type { HomeQuery } from './home.schemas.js'

// M12. Same response shape as the parent home, scoped to the student themself (no child switcher).
// Implemented here: banners (audience all/students) and recommended_teachers (BR-12.3, fully specified).
// Not implemented: recommended_institutes / nearby / top_rated / verified rails — their ranking rules live in
// Module 8 (BR-8.4 to 8.7), which is not part of the spec pack for this work, so they go through the same empty
// `loadRail` seam the parent home uses.

export type StudentHomeContext = { studentId: string; userId: string }

const COMBINED_RAIL_LIMIT = 10
const RAIL_PAGE_LIMIT = 20

type Cursor = { o: number }
const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset } satisfies Cursor)).toString('base64url')
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Cursor).o
    return Number.isInteger(o) && o >= 0 ? o : 0
  } catch {
    return 0
  }
}

async function loadStudent(studentId: string) {
  return db
    .selectFrom('students')
    .select(['class_id', 'board_id', 'city_id', 'area_id', 'parental_consent'])
    .where('id', '=', studentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

type Signals = { coldStart: string[]; searches: string[][]; favouriteCount: number }

async function loadSignals(userId: string): Promise<Signals> {
  let coldStart: string[] = []
  const cached = await kvGet(coldStartKey(userId))
  if (cached) {
    try {
      coldStart = JSON.parse(cached) as string[]
    } catch {
      coldStart = []
    }
  }
  const history = await db
    .selectFrom('user_search_history')
    .select('filters')
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute()
  const searches = history.map((h) => {
    const ids = (h.filters as { subjectIds?: unknown } | null)?.subjectIds
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
  })
  const fav = await db
    .selectFrom('user_favorites')
    .select(db.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('teacher_id', 'is not', null)
    .executeTakeFirst()
  return { coldStart, searches, favouriteCount: Number(fav?.n ?? 0) }
}

type TeacherRow = {
  id: string
  full_name: string
  category_name: string | null
  fee_per_hour_paise: string | null
  rating_avg: string | null
  rating_count: number
  trust_score: string | null
  is_verified_badge: boolean
  score: string
}

function toCard(r: TeacherRow) {
  return {
    teacherId: r.id,
    fullName: r.full_name,
    categoryName: r.category_name,
    feePerHourPaise: r.fee_per_hour_paise === null ? null : Number(r.fee_per_hour_paise),
    ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg),
    ratingCount: r.rating_count,
    trustScore: r.trust_score === null ? null : Number(r.trust_score),
    isVerifiedBadge: r.is_verified_badge,
    // Distance needs teacher/student coordinates, which this spec does not define a rule for.
    distanceLabel: null as string | null,
    score: Math.round(Number(r.score) * 10) / 10,
  }
}

// BR-12.2 eligibility + BR-12.3 scoring, or (no real signal yet) the city's top rated / verified teachers.
async function recommendedTeachers(student: NonNullable<Awaited<ReturnType<typeof loadStudent>>>, userId: string, offset: number, limit: number) {
  const signals = await loadSignals(userId)
  const hasSignal = signals.coldStart.length > 0 || signals.searches.length > 0 || signals.favouriteCount > 0
  const header = hasSignal ? 'Recommended for you' : 'Popular near you'

  const eligible = sql`
    t.verification_status = 'approved' and t.account_status = 'active' and t.deleted_at is null
    and not exists (select 1 from recommendation_dismissals d where d.user_id = ${userId}::uuid and d.teacher_id = t.id)
    and not exists (select 1 from user_blocks b where b.deleted_at is null and (
      (b.blocker_user_id = ${userId}::uuid and b.blocked_user_id = t.user_id) or (b.blocker_user_id = t.user_id and b.blocked_user_id = ${userId}::uuid)))`

  const inCity = sql`exists (select 1 from teacher_locations tl where tl.teacher_id = t.id and tl.city_id = ${student.city_id}::uuid)`

  const score = hasSignal
    ? sql`
      2 * (case when ${student.class_id}::uuid is not null and exists (select 1 from teacher_classes tc where tc.teacher_id = t.id and tc.class_id = ${student.class_id}::uuid
            and (tc.board_id is null or tc.board_id = ${student.board_id}::uuid)) then 1 else 0 end)
      + 2 * (case when exists (select 1 from teacher_subjects ts where ts.teacher_id = t.id and ts.subject_id::text = any(${signals.coldStart}::text[])) then 1 else 0 end)
      + 3 * (case when ${signals.searches.length} = 0 then 0 else (
          select count(*) from jsonb_array_elements(${JSON.stringify(signals.searches)}::jsonb) s
          where exists (select 1 from teacher_subjects ts where ts.teacher_id = t.id and ts.subject_id::text in (select jsonb_array_elements_text(s.value)))
        )::float / ${signals.searches.length} end)
      + 1 * (case when exists (select 1 from user_favorites f join teachers ft on ft.id = f.teacher_id
            where f.user_id = ${userId}::uuid and f.deleted_at is null and ft.category_id = t.category_id) then 1 else 0 end)
      + coalesce(ts2.score, 0) / 100.0
      + 0.5 * (case when exists (select 1 from teacher_locations tl where tl.teacher_id = t.id and tl.city_id = ${student.city_id}::uuid
            and (tl.area_id is null or tl.area_id = ${student.area_id}::uuid)) then 1 else 0 end)`
    : sql`coalesce(ts2.score, 0) / 100.0`

  const order = hasSignal
    ? sql`score desc, t.id`
    : sql`t.is_verified_badge desc, ts2.score desc nulls last, t.rating_avg desc nulls last, t.id`

  const result = await sql<TeacherRow>`
    select t.id, t.full_name, c.name as category_name, t.fee_per_hour_paise, t.rating_avg, t.rating_count, t.trust_score, t.is_verified_badge, (${score}) as score
    from teachers t
    left join teacher_categories c on c.id = t.category_id
    left join trust_scores ts2 on ts2.teacher_id = t.id
    where ${eligible} ${hasSignal ? sql`` : sql`and ${student.city_id ? inCity : sql`false`}`}
    order by ${order}
    offset ${offset} limit ${limit + 1}`.execute(db)

  const rows = result.rows
  const page = rows.slice(0, limit)
  return { header, items: page.map(toCard), nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null }
}

async function loadStudentRail(code: RailCode, student: NonNullable<Awaited<ReturnType<typeof loadStudent>>>, ctx: StudentHomeContext, page: { cursor?: string; limit: number }) {
  if (code === 'recommended_teachers') {
    const r = await recommendedTeachers(student, ctx.userId, decodeCursor(page.cursor), page.limit)
    return { header: r.header, items: r.items as unknown[], nextCursor: r.nextCursor }
  }
  const stub = await loadRail(code, { parentId: '', cityId: student.city_id, areaId: student.area_id, childId: null }, page)
  return { header: code === 'recommended_institutes' ? 'Recommended for you' : undefined, ...stub }
}

export async function getStudentHome(ctx: StudentHomeContext, query: HomeQuery) {
  const student = await loadStudent(ctx.studentId)
  if (!student) throw notFound('Profile not found.')

  // "See all" / single-rail refresh.
  if (query.rail) {
    const page = await loadStudentRail(query.rail, student, ctx, { cursor: query.cursor, limit: query.limit ?? RAIL_PAGE_LIMIT })
    return { data: { items: page.items }, meta: { nextCursor: page.nextCursor } }
  }

  const cachedAt = new Date().toISOString()
  const limit = query.limit ?? COMBINED_RAIL_LIMIT
  const rails: Record<string, unknown> = {}
  for (const code of RAIL_CODES) {
    const page = await loadStudentRail(code, student, ctx, { limit })
    rails[code] = { ...(page.header ? { header: page.header } : {}), items: page.items, nextCursor: page.nextCursor, cachedAt }
  }

  return {
    data: {
      parentalConsent: student.parental_consent,
      banners: await banners(student.city_id, ['all', 'students']),
      rails,
    },
    meta: { rails: Object.fromEntries(RAIL_CODES.map((code) => [code, { cachedAt }])) },
  }
}
