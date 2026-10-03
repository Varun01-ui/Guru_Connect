import { db } from '../../../db/index.js'
import { scheduleRepeatingJob } from '../../../lib/jobs.js'
import { createNotification } from '../../../lib/notify.js'
import { sendDraftReminders } from '../institute/institute.service.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

// M20 BR-20.5: a teacher whose lead is still new/viewed gets a reminder 6 h and again 20 h after it arrived, then no
// more (Module 38 closes a lead after 30 days). Each milestone has its own dedupe key, so re-running the job in the
// same window sends nothing twice. A lead already past a milestone when the job first sees it only gets the
// milestone it is currently in, never a burst of catch-up reminders.
export async function sendUnansweredLeadReminders(now = new Date()): Promise<number> {
  const rows = await db
    .selectFrom('leads as l')
    .innerJoin('teachers as t', 't.id', 'l.teacher_id')
    .innerJoin('app_users as u', 'u.id', 'l.requester_user_id')
    .select(['l.id', 'l.created_at', 'u.full_name', 't.user_id as teacher_user_id'])
    .where('l.target_type', '=', 'teacher')
    .where('l.status', 'in', ['new', 'viewed'])
    .where('l.deleted_at', 'is', null)
    .where('l.created_at', '<=', new Date(now.getTime() - 6 * HOUR))
    .where('l.created_at', '>', new Date(now.getTime() - 30 * DAY))
    .execute()

  let sent = 0
  for (const lead of rows) {
    const ageHours = (now.getTime() - lead.created_at.getTime()) / HOUR
    const milestone = ageHours >= 20 ? 2 : 1
    const inserted = await createNotification(db, {
      userId: lead.teacher_user_id,
      category: 'leads',
      eventType: 'lead.reminder',
      title: 'Still waiting for your reply',
      body: `${lead.full_name.split(' ')[0]}'s enquiry has been open for ${Math.floor(ageHours)} hours.`,
      deepLink: `gc://teacher/leads/${lead.id}`,
      data: { leadId: lead.id, milestone },
      dedupeKey: `lead_reminder_${milestone}:${lead.id}`,
    })
    if (inserted) sent += 1
  }
  return sent
}

// M20 BR-20.9: 7, 3 and 1 day(s) before a premium/featured listing or a teacher plan ends. The milestone is chosen
// by how much time is left, so each period produces at most one reminder per milestone.
export const expiryMilestone = (msLeft: number): 7 | 3 | 1 | null => (msLeft <= 0 || msLeft > 7 * DAY ? null : msLeft > 3 * DAY ? 7 : msLeft > DAY ? 3 : 1)

export async function sendExpiryReminders(now = new Date()): Promise<number> {
  type Item = { userId: string; id: string; planName: string; endsAt: Date }
  const items: Item[] = []

  const boosts = await db
    .selectFrom('teachers')
    .select(['id', 'user_id', 'is_premium', 'premium_until', 'is_featured', 'featured_until'])
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb.and([eb('is_premium', '=', true), eb('premium_until', '>', now)]), eb.and([eb('is_featured', '=', true), eb('featured_until', '>', now)])]))
    .execute()
  for (const t of boosts) {
    if (t.is_premium && t.premium_until) items.push({ userId: t.user_id, id: `${t.id}-premium-${t.premium_until.toISOString().slice(0, 10)}`, planName: 'Premium', endsAt: t.premium_until })
    if (t.is_featured && t.featured_until) items.push({ userId: t.user_id, id: `${t.id}-featured-${t.featured_until.toISOString().slice(0, 10)}`, planName: 'Featured', endsAt: t.featured_until })
  }

  const subs = await db
    .selectFrom('subscriptions as s')
    .leftJoin('payment_configurations as c', 'c.id', 's.payment_configuration_id')
    .select(['s.id', 's.user_id', 's.ends_at', 'c.name as plan_name'])
    .where('s.subscriber_type', '=', 'teacher')
    .where('s.status', '=', 'active')
    .where('s.ends_at', '>', now)
    .execute()
  for (const s of subs) items.push({ userId: s.user_id, id: s.id, planName: s.plan_name ?? 'Membership', endsAt: s.ends_at! })

  let sent = 0
  for (const item of items) {
    const days = expiryMilestone(item.endsAt.getTime() - now.getTime())
    if (!days) continue
    const inserted = await createNotification(db, {
      userId: item.userId,
      category: 'subscription',
      eventType: 'subscription.expiring',
      title: `Your ${item.planName} listing expires soon`,
      body: `${days} ${days === 1 ? 'day' : 'days'} left. Renew to keep your premium placement in search.`,
      deepLink: 'gc://plans',
      data: { days },
      dedupeKey: `sub_expiry_${days}:${item.id}`,
    })
    if (inserted) sent += 1
  }
  return sent
}

export function startNotificationJobs() {
  return scheduleRepeatingJob({
    queueName: 'notifications-reminders',
    schedulerId: 'notification-reminders-hourly',
    pattern: '*/30 * * * *',
    handler: async () => {
      const [leads, expiry, drafts] = [await sendUnansweredLeadReminders(), await sendExpiryReminders(), await sendDraftReminders()]
      if (leads + expiry + drafts > 0) console.log(`[jobs] sent ${leads} lead, ${expiry} expiry and ${drafts} institute draft reminders`)
    },
  })
}

