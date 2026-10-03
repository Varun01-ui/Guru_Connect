import { sql } from 'kysely'
import { db } from '../../db/index.js'
import { scheduleRepeatingJob } from '../../lib/jobs.js'
import { kvGet, kvSet } from '../../lib/kv.js'
import { sendMail } from '../../lib/mailer.js'
import { runChecks } from './tv.checks.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// FR-16.2: a claim with no activity for 30 minutes is cleared and the case goes back to the queue. Activity is any
// log entry the reviewer wrote on the case (claiming, document decisions, notes).
export async function releaseStaleClaims(now = new Date(), inactivityMs = 30 * MINUTE): Promise<number> {
  const cutoff = new Date(now.getTime() - inactivityMs)
  const stale = await sql<{ id: string; reviewed_by: string }>`
    select t.id, t.reviewed_by from teachers t
    where t.verification_status = 'under_review' and t.reviewed_by is not null and t.deleted_at is null
      and coalesce((select max(l.created_at) from teacher_verification_logs l where l.teacher_id = t.id and l.admin_id = t.reviewed_by), t.updated_at) < ${cutoff}`.execute(db)
  let released = 0
  for (const row of stale.rows) {
    await db.transaction().execute(async (trx) => {
      const r = await trx.updateTable('teachers').set({ reviewed_by: null, verification_status: 'pending' }).where('id', '=', row.id).where('verification_status', '=', 'under_review').where('reviewed_by', '=', row.reviewed_by).returning('id').executeTakeFirst()
      if (!r) return
      await trx.insertInto('teacher_verification_logs').values({ teacher_id: row.id, action: 'assigned', from_status: 'under_review', to_status: 'pending', note: 'Claim expired after 30 minutes of inactivity', is_internal: true, metadata: JSON.stringify({ released: true, reason: 'inactivity' }) as never }).execute()
      released += 1
    })
  }
  return released
}

// FR-16.4: checks run when documents are (re)submitted. The queue is scanned for cases whose newest submission has no
// check results yet, so a re-run happens automatically after a re-upload.
export async function runPendingChecks(): Promise<number> {
  const due = await sql<{ id: string }>`
    select t.id from teachers t
    where t.deleted_at is null and t.verification_status in ('pending','under_review')
      and not exists (
        select 1 from teacher_verification_logs c
        where c.teacher_id = t.id and c.action = 'auto_check'
          and c.created_at >= coalesce((select max(s.created_at) from teacher_verification_logs s where s.teacher_id = t.id and s.action in ('submitted','resubmitted')), t.submitted_at, t.created_at))`.execute(db)
  for (const { id } of due.rows) {
    const results = await runChecks(id)
    for (const r of results) {
      await db.insertInto('teacher_verification_logs').values({ teacher_id: id, action: 'auto_check', is_internal: true, metadata: JSON.stringify({ type: r.type, result: r.result, score: r.score, detail: r.detail }) as never }).execute()
    }
    // Nothing to report (no vendor checks) still counts as "ran", so the case is not rescanned every run.
    if (results.length === 0) await db.insertInto('teacher_verification_logs').values({ teacher_id: id, action: 'auto_check', is_internal: true, metadata: JSON.stringify({ type: 'none', result: 'pass' }) as never }).execute()
  }
  return due.rows.length
}

// FR-16.11: one e-mail per case that passes 24 hours, to admins who switched `queue_alerts` on (M03 FR-3.5).
export async function sendSlaAlerts(now = new Date()): Promise<number> {
  const breached = await sql<{ id: string; public_code: string; full_name: string; submitted_at: Date }>`
    select id, public_code, full_name, submitted_at from teachers
    where deleted_at is null and verification_status in ('pending','under_review') and submitted_at < ${new Date(now.getTime() - 24 * HOUR)}`.execute(db)
  const fresh: typeof breached.rows = []
  for (const t of breached.rows) if (!(await kvGet(`sla:alerted:${t.id}:${t.submitted_at.getTime()}`))) fresh.push(t)
  if (fresh.length === 0) return 0

  const recipients = await sql<{ email: string }>`
    select a.email from admins a left join admin_profiles p on p.admin_id = a.id
    where a.deleted_at is null and a.status = 'active' and coalesce((p.notification_prefs->>'queue_alerts')::boolean, true)
      and (a.is_super_admin or exists (select 1 from admin_roles ar join role_permissions rp on rp.role_id = ar.role_id join permissions pm on pm.id = rp.permission_id where ar.admin_id = a.id and pm.key = 'teacher_verification.review'))`.execute(db)
  const lines = fresh.map((t) => `- ${t.public_code} ${t.full_name} (waiting ${Math.floor((now.getTime() - t.submitted_at.getTime()) / HOUR)} h)`)
  for (const r of recipients.rows) {
    await sendMail({ to: r.email, subject: `${fresh.length} teacher application(s) past 24 hours`, text: `These cases have been waiting longer than 24 hours:\n${lines.join('\n')}` })
  }
  for (const t of fresh) await kvSet(`sla:alerted:${t.id}:${t.submitted_at.getTime()}`, '1', 7 * 24 * 3600)
  return fresh.length
}

export function startTeacherVerificationJobs() {
  return scheduleRepeatingJob({
    queueName: 'teacher-verification',
    schedulerId: 'teacher-verification-maintenance',
    pattern: '*/5 * * * *',
    handler: async () => {
      const [released, checked] = [await releaseStaleClaims(), await runPendingChecks()]
      if (new Date().getMinutes() % 15 < 5) await sendSlaAlerts()
      if (released + checked > 0) console.log(`[jobs] released ${released} stale claims, ran checks on ${checked} cases`)
    },
  })
}
