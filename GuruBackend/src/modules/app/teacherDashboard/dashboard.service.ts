import { sql } from 'kysely'
import { db } from '../../../db/index.js'
import { notFound } from '../../../lib/errors.js'
import { shortName } from '../../../lib/names.js'
import * as teacherRepo from '../teacher/teacher.repository.js'
import { istToday } from '../teacherAvailability/availability.service.js'

const DAY_MS = 86_400_000
const IST_OFFSET_MS = 5.5 * 3_600_000

const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const istDayStart = (isoDate: string) => new Date(Date.parse(`${isoDate}T00:00:00Z`) - IST_OFFSET_MS)
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

// BR-18.4: the bands Admin M36's simulate endpoint uses.
export function trustBand(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 90) return 'excellent'
  if (score >= 80) return 'good'
  if (score >= 60) return 'fair'
  return 'poor'
}

// Trust factor (column on trust_scores) <- weight key in trust_score_weights.weights.
const FACTORS: { weightKey: string; column: 'aadhaar_score' | 'pan_score' | 'certificate_score' | 'review_score' | 'complaint_score' | 'completeness_score'; suggestion: string }[] = [
  { weightKey: 'aadhaar', column: 'aadhaar_score', suggestion: 'Get your Aadhaar verified to improve your score' },
  { weightKey: 'pan', column: 'pan_score', suggestion: 'Get your PAN verified to improve your score' },
  { weightKey: 'certificates', column: 'certificate_score', suggestion: 'Add a certificate to improve your score' },
  { weightKey: 'reviews', column: 'review_score', suggestion: 'Ask your students for reviews to improve your score' },
  { weightKey: 'complaints', column: 'complaint_score', suggestion: 'Resolve open complaints to improve your score' },
  { weightKey: 'profile_completeness', column: 'completeness_score', suggestion: 'Complete your profile to improve your score' },
]

// The factor with the most weighted room to improve: (100 - value) x weight, largest first.
export function topSuggestion(factors: Record<string, number>, weights: Record<string, number>): string | null {
  let best: { gap: number; suggestion: string } | null = null
  for (const f of FACTORS) {
    const gap = (100 - (factors[f.column] ?? 0)) * (weights[f.weightKey] ?? 0)
    if (gap > 0 && (!best || gap > best.gap)) best = { gap, suggestion: f.suggestion }
  }
  return best?.suggestion ?? null
}

type Totals = { profile_views: number; unique_viewers: number; lead_requests: number; demo_requests: number; demos_completed: number; reviews_published: number; rating_sum: number }

async function sumStats(teacherId: string, from: string, to: string): Promise<Totals> {
  const row = await db
    .selectFrom('teacher_daily_stats')
    .select([
      sql<number>`coalesce(sum(profile_views), 0)::int`.as('profile_views'),
      sql<number>`coalesce(sum(unique_viewers), 0)::int`.as('unique_viewers'),
      sql<number>`coalesce(sum(lead_requests), 0)::int`.as('lead_requests'),
      sql<number>`coalesce(sum(demo_requests), 0)::int`.as('demo_requests'),
      sql<number>`coalesce(sum(demos_completed), 0)::int`.as('demos_completed'),
      sql<number>`coalesce(sum(reviews_published), 0)::int`.as('reviews_published'),
      sql<number>`coalesce(sum(rating_sum), 0)::int`.as('rating_sum'),
    ])
    .where('teacher_id', '=', teacherId)
    .where(sql<boolean>`stat_date between ${from}::date and ${to}::date`)
    .executeTakeFirstOrThrow()
  return row
}

const avgRating = (t: Totals) => (t.reviews_published > 0 ? round(t.rating_sum / t.reviews_published, 2) : null)
// null when there is nothing to compare against (a percentage of zero is undefined).
const delta = (cur: number, prev: number) => (prev === 0 ? null : round(((cur - prev) / prev) * 100, 1))

function tiles(cur: Totals, prev: Totals) {
  const tile = (key: keyof Totals) => ({ value: cur[key], previous: prev[key], deltaPct: delta(cur[key], prev[key]) })
  return {
    profileViews: tile('profile_views'),
    uniqueViewers: tile('unique_viewers'),
    leadRequests: tile('lead_requests'),
    demoRequests: tile('demo_requests'),
    demosCompleted: tile('demos_completed'),
    reviewsPublished: tile('reviews_published'),
    avgRating: { value: avgRating(cur), previous: avgRating(prev) },
  }
}

async function responseStats(teacherId: string, from: Date) {
  const row = await sql<{ total: number; fast: number; median: number | null }>`
    select count(*)::int as total,
           count(*) filter (where first_response_at is not null and first_response_at <= created_at + interval '24 hours')::int as fast,
           (percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - created_at)) / 60)
              filter (where first_response_at is not null)) as median
    from leads
    where teacher_id = ${teacherId} and target_type = 'teacher' and deleted_at is null and status <> 'spam' and created_at >= ${from}`.execute(db)
  const r = row.rows[0]!
  return { responseRatePct: r.total > 0 ? round((r.fast / r.total) * 100, 1) : null, medianFirstResponseMinutes: r.median === null ? null : Math.round(Number(r.median)) }
}

async function liveCounters(teacherId: string, now: Date) {
  const [leads, demos] = await Promise.all([
    sql<{ unanswered: number; open: number }>`
      select count(*) filter (where status in ('new','viewed') and created_at < ${new Date(now.getTime() - DAY_MS)})::int as unanswered,
             count(*) filter (where status in ('new','viewed','contacted'))::int as open
      from leads where teacher_id = ${teacherId} and target_type = 'teacher' and deleted_at is null`.execute(db),
    sql<{ n: number }>`
      select count(*)::int as n from demo_requests
      where teacher_id = ${teacherId} and status in ('requested','confirmed','reschedule_proposed')
        and coalesce(confirmed_start_at, requested_start_at) >= ${now}`.execute(db),
  ])
  return { unansweredLeads: leads.rows[0]!.unanswered, openLeads: leads.rows[0]!.open, upcomingDemos: demos.rows[0]!.n }
}

type Activity = { type: string; at: Date; label: string; deepLink: string }

// BR-18.6: the five most recent events, one line each; requesters are only ever "First L.".
async function recentActivity(teacherId: string): Promise<{ type: string; at: string; label: string; deepLink: string }[]> {
  const events: Activity[] = []

  const leads = await db
    .selectFrom('leads as l')
    .innerJoin('app_users as u', 'u.id', 'l.requester_user_id')
    .select(['l.id', 'l.status', 'l.created_at', 'l.updated_at', 'u.full_name'])
    .where('l.teacher_id', '=', teacherId)
    .where('l.target_type', '=', 'teacher')
    .where('l.deleted_at', 'is', null)
    .orderBy('l.created_at', 'desc')
    .limit(5)
    .execute()
  for (const l of leads) events.push({ type: 'lead_created', at: l.created_at, label: `New lead from ${shortName(l.full_name)}`, deepLink: `gc://leads/${l.id}` })
  const converted = await db
    .selectFrom('leads as l')
    .innerJoin('app_users as u', 'u.id', 'l.requester_user_id')
    .select(['l.id', 'l.updated_at', 'u.full_name'])
    .where('l.teacher_id', '=', teacherId)
    .where('l.target_type', '=', 'teacher')
    .where('l.deleted_at', 'is', null)
    .where('l.status', '=', 'converted')
    .orderBy('l.updated_at', 'desc')
    .limit(5)
    .execute()
  for (const l of converted) events.push({ type: 'lead_converted', at: l.updated_at, label: `Lead from ${shortName(l.full_name)} converted`, deepLink: `gc://leads/${l.id}` })

  const reviews = await db
    .selectFrom('teacher_reviews')
    .select(['id', 'rating', 'author_type', 'published_at'])
    .where('teacher_id', '=', teacherId)
    .where('status', '=', 'published')
    .where('deleted_at', 'is', null)
    .where('published_at', 'is not', null)
    .orderBy('published_at', 'desc')
    .limit(5)
    .execute()
  for (const r of reviews) events.push({ type: 'review_published', at: r.published_at!, label: `New ${r.rating}★ review from a ${r.author_type}`, deepLink: `gc://teacher/reviews/${r.id}` })

  const demos = await db
    .selectFrom('demo_requests as d')
    .innerJoin('app_users as u', 'u.id', 'd.requester_user_id')
    .select(['d.id', 'd.status', 'd.completed_at', 'd.updated_at', 'u.full_name'])
    .where('d.teacher_id', '=', teacherId)
    .where('d.status', 'in', ['completed', 'no_show'])
    .orderBy('d.updated_at', 'desc')
    .limit(5)
    .execute()
  for (const d of demos) {
    events.push(
      d.status === 'completed'
        ? { type: 'demo_completed', at: d.completed_at ?? d.updated_at, label: `Demo with ${shortName(d.full_name)} completed`, deepLink: `gc://demos/${d.id}` }
        : { type: 'demo_no_show', at: d.updated_at, label: `${shortName(d.full_name)} didn't attend the demo`, deepLink: `gc://demos/${d.id}` },
    )
  }
  return events
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 5)
    .map((e) => ({ type: e.type, at: e.at.toISOString(), label: e.label, deepLink: e.deepLink }))
}

export async function getDashboard(teacherId: string, range: 7 | 30, now = new Date()) {
  const t = await db.selectFrom('teachers').select(['verification_status']).where('id', '=', teacherId).where('deleted_at', 'is', null).executeTakeFirst()
  if (!t) throw notFound('Profile not found.')

  // Not approved yet: no metrics at all (null, not zeros), only the state the banners need (BR-18.7).
  if (t.verification_status !== 'approved') {
    let flagged = 0
    if (t.verification_status === 'reupload_requested') {
      const r = await db.selectFrom('teacher_documents').select(db.fn.countAll<number>().as('n')).where('teacher_id', '=', teacherId).where('is_current', '=', true).where('status', 'in', ['reupload_requested', 'rejected']).executeTakeFirstOrThrow()
      flagged = Number(r.n)
    }
    return {
      verificationStatus: t.verification_status,
      range,
      kpis: null,
      trustScore: null,
      profileCompleteness: null,
      unansweredLeads: 0,
      recentActivity: [] as never[],
      ...(t.verification_status === 'reupload_requested' ? { documentsNeedingAttention: flagged } : {}),
    }
  }

  const to = istToday(now)
  const from = addDays(to, -(range - 1))
  const prevTo = addDays(from, -1)
  const prevFrom = addDays(prevTo, -(range - 1))

  const [cur, prev, response, live, activity, completeness, trust, weights] = await Promise.all([
    sumStats(teacherId, from, to),
    sumStats(teacherId, prevFrom, prevTo),
    responseStats(teacherId, istDayStart(from)),
    liveCounters(teacherId, now),
    recentActivity(teacherId),
    teacherRepo.completenessItems(db, teacherId),
    db.selectFrom('trust_scores').selectAll().where('teacher_id', '=', teacherId).executeTakeFirst(),
    db.selectFrom('trust_score_weights').select('weights').where('status', '=', 'active').orderBy('version', 'desc').executeTakeFirst(),
  ])

  const percent = Math.min(100, completeness.reduce((s, i) => s + i.earned, 0))
  const missing = completeness.filter((i) => i.earned < i.of).sort((a, b) => b.of - a.of)[0]
  const score = trust ? Number(trust.score) : null

  return {
    verificationStatus: t.verification_status,
    range,
    period: { from, to },
    previousPeriod: { from: prevFrom, to: prevTo },
    kpis: tiles(cur, prev),
    ...response,
    trustScore: trust && score !== null ? { score, band: trustBand(score), suggestion: topSuggestion(trust as unknown as Record<string, number>, weights?.weights ?? {}) } : null,
    profileCompleteness: { percent, nextItem: missing ? { key: missing.key, label: missing.nextLabel, points: missing.of } : null },
    ...live,
    recentActivity: activity,
  }
}
