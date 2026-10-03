import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { signAppAccessToken } from '../../../lib/appJwt.js'
import { createNotification } from '../../../lib/notify.js'
import { APP, bearer, createParent, createStudent, createTeacher, loadMasters, purgeUsersByPhone } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestTeacher } from '../../../test/appHelpers.js'
import { expiryMilestone, sendExpiryReminders, sendUnansweredLeadReminders } from './notifications.jobs.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let requester: TestParent

const HOUR = 3_600_000
const DAY = 24 * HOUR

async function newTeacher(): Promise<TestTeacher> {
  const t = await createTeacher(m)
  phones.push(t.phone)
  return t
}
async function newParent(): Promise<TestParent> {
  const p = await createParent(m)
  phones.push(p.phone)
  return p
}
const api = (u: { token: string }) => ({
  get: () => request(app).get(`${APP}/notification-preferences`).set(bearer(u)),
  put: (items: unknown) => request(app).put(`${APP}/notification-preferences`).set(bearer(u)).send({ items }),
})
const stored = (userId: string) => db.selectFrom('user_notification_preferences').selectAll().where('user_id', '=', userId).orderBy('category').execute()
const keys = (res: request.Response) => res.body.data.items.map((i: { category: string }) => i.category) as string[]

beforeAll(async () => {
  m = await loadMasters()
  requester = await newParent()
  await db.updateTable('app_users').set({ full_name: 'Lakshmi Venkatesh' }).where('id', '=', requester.userId).execute()
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('GET /notification-preferences (BR-20.1)', () => {
  it('shows a teacher ten categories with defaults and locks (no recommendations)', async () => {
    const t = await newTeacher()
    const res = await api(t).get()
    expect(res.status).toBe(200)
    expect(keys(res)).toEqual(['account', 'verification', 'leads', 'demos', 'reviews', 'payments', 'subscription', 'referral', 'complaints', 'announcements'])
    expect(res.body.data.items.find((i: { category: string }) => i.category === 'leads')).toEqual({ category: 'leads', label: 'Leads', description: 'New enquiries and messages', pushEnabled: true, emailEnabled: false, locked: false, quietHoursStart: null, quietHoursEnd: null })
    const locked = res.body.data.items.filter((i: { locked: boolean }) => i.locked).map((i: { category: string }) => i.category)
    expect(locked).toEqual(['account', 'payments'])
  })

  it('shows learners recommendations but not verification (T20.8)', async () => {
    const p = await newParent()
    const s = await createStudent(m)
    phones.push(s.phone)
    for (const user of [p, s]) {
      const list = keys(await api(user).get())
      expect(list).toContain('recommendations')
      expect(list).not.toContain('verification')
      expect(list).toHaveLength(10)
    }
  })

  it('serves institute staff too', async () => {
    const p = await newParent()
    const token = signAppAccessToken({ sub: p.userId, role: 'institute_staff', pid: '', sid: randomUUID() })
    const list = keys(await api({ token }).get())
    expect(list).toContain('verification')
    expect(list).not.toContain('recommendations')
  })

  it('requires sign-in', async () => {
    expect((await request(app).get(`${APP}/notification-preferences`)).status).toBe(401)
    expect((await request(app).put(`${APP}/notification-preferences`).send({ items: [] })).status).toBe(401)
  })
})

describe('PUT /notification-preferences (BR-20.3)', () => {
  it('round-trips a toggle and leaves categories not sent unchanged (T20.1)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const off = await c.put([{ category: 'reviews', pushEnabled: false, emailEnabled: false }])
    expect(off.status).toBe(200)
    expect(off.body.data.items.find((i: { category: string }) => i.category === 'reviews')).toMatchObject({ pushEnabled: false, emailEnabled: false })
    expect(off.body.data.items.find((i: { category: string }) => i.category === 'leads')).toMatchObject({ pushEnabled: true })
    const on = await c.put([{ category: 'reviews', pushEnabled: true, emailEnabled: true }, { category: 'leads', pushEnabled: true, emailEnabled: true, quietHoursStart: null, quietHoursEnd: null }])
    expect(on.body.data.items.find((i: { category: string }) => i.category === 'reviews')).toMatchObject({ pushEnabled: true, emailEnabled: true })
    expect((await c.get()).body.data.items.find((i: { category: string }) => i.category === 'leads')).toMatchObject({ emailEnabled: true })
    expect((await stored(t.userId)).map((r) => r.category)).toEqual(['leads', 'reviews'])
  })

  it('refuses to silence account and payments push, server-side (BR-20.2, T20.2)', async () => {
    const t = await newTeacher()
    const res = await api(t).put([
      { category: 'reviews', pushEnabled: true, emailEnabled: false },
      { category: 'leads', pushEnabled: true, emailEnabled: false },
      { category: 'payments', pushEnabled: false, emailEnabled: false },
    ])
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: "Security and payment alerts can't be turned off.", details: { path: 'items[2].pushEnabled' } })
    expect(await stored(t.userId)).toEqual([]) // nothing was saved
    expect((await api(t).put([{ category: 'account', pushEnabled: false, emailEnabled: true }])).status).toBe(422)
    // email stays toggleable on locked categories
    const ok = await api(t).put([{ category: 'payments', pushEnabled: true, emailEnabled: true }, { category: 'account', pushEnabled: true, emailEnabled: true }])
    expect(ok.status).toBe(200)
    expect(ok.body.data.items.find((i: { category: string }) => i.category === 'payments')).toMatchObject({ emailEnabled: true, locked: true })
  })

  it('rejects unknown, duplicate and role-inappropriate categories without saving anything', async () => {
    const t = await newTeacher()
    const p = await newParent()
    const good = { category: 'reviews', pushEnabled: false, emailEnabled: false }
    for (const [user, bad] of [
      [t, { category: 'bogus', pushEnabled: true, emailEnabled: false }],
      [t, { category: 'recommendations', pushEnabled: true, emailEnabled: false }],
      [p, { category: 'verification', pushEnabled: true, emailEnabled: false }],
      [t, good],
    ] as const) {
      const res = await api(user).put([good, bad])
      expect(res.status, JSON.stringify(bad)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
    expect(await stored(t.userId)).toEqual([])
    expect(await stored(p.userId)).toEqual([])
  })

  it('validates the payload shape', async () => {
    const t = await newTeacher()
    for (const items of [[], [{ category: 'leads' }], [{ category: 'leads', pushEnabled: 'yes', emailEnabled: false }], 'x', [{ category: 'leads', pushEnabled: true, emailEnabled: false, quietHoursStart: '25:00', quietHoursEnd: '07:00' }]]) {
      expect((await api(t).put(items)).status, JSON.stringify(items)).toBe(422)
    }
    expect((await request(app).put(`${APP}/notification-preferences`).set(bearer(t)).send({})).status).toBe(422)
  })

  it('needs quiet hours start and end together and keeps them per category (T20.6)', async () => {
    const t = await newTeacher()
    const c = api(t)
    const onlyStart = await c.put([{ category: 'demos', pushEnabled: true, emailEnabled: false, quietHoursStart: '22:00' }])
    expect(onlyStart.status).toBe(422)
    expect(onlyStart.body.error.message).toBe('Set both a start and end time.')
    expect((await c.put([{ category: 'demos', pushEnabled: true, emailEnabled: false, quietHoursStart: '22:00', quietHoursEnd: null }])).status).toBe(422)

    const set = await c.put([{ category: 'demos', pushEnabled: true, emailEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '06:00' }])
    expect(set.status).toBe(200)
    const items = set.body.data.items as { category: string; quietHoursStart: string | null; quietHoursEnd: string | null }[]
    expect(items.find((i) => i.category === 'demos')).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '06:00' })
    expect(items.find((i) => i.category === 'leads')).toMatchObject({ quietHoursStart: null, quietHoursEnd: null })

    // omitting quiet hours keeps them; sending nulls clears them
    const keep = await c.put([{ category: 'demos', pushEnabled: false, emailEnabled: false }])
    expect(keep.body.data.items.find((i: { category: string }) => i.category === 'demos')).toMatchObject({ pushEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '06:00' })
    const clear = await c.put([{ category: 'demos', pushEnabled: false, emailEnabled: false, quietHoursStart: null, quietHoursEnd: null }])
    expect(clear.body.data.items.find((i: { category: string }) => i.category === 'demos')).toMatchObject({ quietHoursStart: null, quietHoursEnd: null })
  })

  it('audits only rows that actually changed', async () => {
    const t = await newTeacher()
    const audits = async () => (await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', t.userId).where('action', '=', 'app.notification_preference_updated').orderBy('created_at').execute()).map((a) => a.new_values)
    await api(t).put([{ category: 'reviews', pushEnabled: false, emailEnabled: false }, { category: 'leads', pushEnabled: true, emailEnabled: false }]) // leads == default
    expect(await audits()).toEqual([{ category: 'reviews', pushEnabled: false, emailEnabled: false }])
    await api(t).put([{ category: 'reviews', pushEnabled: false, emailEnabled: false }]) // unchanged
    expect(await audits()).toHaveLength(1)
    await api(t).put([{ category: 'reviews', pushEnabled: false, emailEnabled: true }])
    expect(await audits()).toHaveLength(2)
  })

  it('is scoped to the caller', async () => {
    const a = await newTeacher()
    const b = await newTeacher()
    await api(a).put([{ category: 'reviews', pushEnabled: false, emailEnabled: true }])
    expect((await api(b).get()).body.data.items.find((i: { category: string }) => i.category === 'reviews')).toMatchObject({ pushEnabled: true, emailEnabled: false })
  })
})

describe('inbox rows follow the preferences (T20.5)', () => {
  it('marks push as skipped when the category is switched off, but still writes the row', async () => {
    const t = await newTeacher()
    await api(t).put([{ category: 'leads', pushEnabled: false, emailEnabled: false }])
    expect(await createNotification(db, { userId: t.userId, category: 'leads', eventType: 'lead.received', title: 'New lead!', body: 'x', dedupeKey: 'k1' })).toBe(true)
    expect(await createNotification(db, { userId: t.userId, category: 'reviews', eventType: 'review.published', title: 'New review', body: 'x' })).toBe(true)
    const rows = await db.selectFrom('user_notifications').select(['category', 'push_status']).where('user_id', '=', t.userId).orderBy('category').execute()
    expect(rows).toEqual([{ category: 'leads', push_status: 'skipped_pref' }, { category: 'reviews', push_status: 'pending' }])
    expect(await createNotification(db, { userId: t.userId, category: 'leads', eventType: 'lead.received', title: 'New lead!', body: 'x', dedupeKey: 'k1' })).toBe(false) // deduped
  })
})

async function addLead(teacherId: string, createdAt: Date, status = 'new') {
  return db
    .insertInto('leads')
    .values({ lead_type: 'inquiry', target_type: 'teacher', teacher_id: teacherId, requester_user_id: requester.userId, requester_type: 'parent', status, created_at: createdAt } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
}
const inbox = (userId: string, eventType: string) => db.selectFrom('user_notifications').select(['title', 'body', 'deep_link', 'dedupe_key', 'category', 'push_status']).where('user_id', '=', userId).where('event_type', '=', eventType).orderBy('dedupe_key').execute()

describe('unanswered-lead reminders (BR-20.5)', () => {
  it('sends the 6-hour reminder exactly once even if the job runs twice (T20.4)', async () => {
    const t = await newTeacher()
    const created = new Date('2026-10-01T10:00:00Z')
    const lead = await addLead(t.teacherId, created)
    expect(await sendUnansweredLeadReminders(new Date(created.getTime() + 5 * HOUR))).toBeGreaterThanOrEqual(0)
    expect(await inbox(t.userId, 'lead.reminder')).toEqual([])
    const at = new Date(created.getTime() + 6.5 * HOUR)
    await sendUnansweredLeadReminders(at)
    await sendUnansweredLeadReminders(new Date(at.getTime() + 10 * 60_000))
    const rows = await inbox(t.userId, 'lead.reminder')
    expect(rows).toEqual([{ title: 'Still waiting for your reply', body: "Lakshmi's enquiry has been open for 6 hours.", deep_link: `gc://teacher/leads/${lead.id}`, dedupe_key: `lead_reminder_1:${lead.id}`, category: 'leads', push_status: 'pending' }])
  })

  it('sends the second reminder at 20 hours and then stops', async () => {
    const t = await newTeacher()
    const created = new Date('2026-10-01T10:00:00Z')
    const lead = await addLead(t.teacherId, created)
    await sendUnansweredLeadReminders(new Date(created.getTime() + 7 * HOUR))
    await sendUnansweredLeadReminders(new Date(created.getTime() + 21 * HOUR))
    await sendUnansweredLeadReminders(new Date(created.getTime() + 40 * HOUR))
    await sendUnansweredLeadReminders(new Date(created.getTime() + 3 * DAY))
    const rows = await inbox(t.userId, 'lead.reminder')
    expect(rows.map((r) => r.dedupe_key)).toEqual([`lead_reminder_1:${lead.id}`, `lead_reminder_2:${lead.id}`])
    expect(rows[1]!.body).toBe("Lakshmi's enquiry has been open for 21 hours.")
  })

  it('does not send catch-up bursts, answered, closed or ancient leads', async () => {
    const t = await newTeacher()
    const now = new Date('2026-10-20T10:00:00Z')
    const late = await addLead(t.teacherId, new Date(now.getTime() - 22 * HOUR)) // first seen past both milestones
    await addLead(t.teacherId, new Date(now.getTime() - 22 * HOUR), 'contacted')
    await addLead(t.teacherId, new Date(now.getTime() - 22 * HOUR), 'closed')
    await addLead(t.teacherId, new Date(now.getTime() - 31 * DAY))
    await sendUnansweredLeadReminders(now)
    const rows = await inbox(t.userId, 'lead.reminder')
    expect(rows.map((r) => r.dedupe_key)).toEqual([`lead_reminder_2:${late.id}`])
  })

  it('records skipped_pref when the teacher turned leads push off', async () => {
    const t = await newTeacher()
    await api(t).put([{ category: 'leads', pushEnabled: false, emailEnabled: false }])
    const created = new Date('2026-10-01T10:00:00Z')
    await addLead(t.teacherId, created)
    await sendUnansweredLeadReminders(new Date(created.getTime() + 7 * HOUR))
    expect((await inbox(t.userId, 'lead.reminder')).map((r) => r.push_status)).toEqual(['skipped_pref'])
  })
})

describe('expiry reminders (BR-20.9)', () => {
  it('picks the milestone from the time left', () => {
    expect(expiryMilestone(8 * DAY)).toBeNull()
    expect(expiryMilestone(7 * DAY)).toBe(7)
    expect(expiryMilestone(4 * DAY)).toBe(7)
    expect(expiryMilestone(3 * DAY)).toBe(3)
    expect(expiryMilestone(2 * DAY)).toBe(3)
    expect(expiryMilestone(DAY)).toBe(1)
    expect(expiryMilestone(HOUR)).toBe(1)
    expect(expiryMilestone(0)).toBeNull()
    expect(expiryMilestone(-HOUR)).toBeNull()
  })

  it('sends 7, 3 and 1 day reminders for a premium listing, each once (T20.9)', async () => {
    const t = await newTeacher()
    const until = new Date('2026-11-10T10:00:00Z')
    await db.updateTable('teachers').set({ is_premium: true, premium_until: until }).where('id', '=', t.teacherId).execute()
    const run = (offsetMs: number) => sendExpiryReminders(new Date(until.getTime() - offsetMs))
    await run(10 * DAY)
    expect(await inbox(t.userId, 'subscription.expiring')).toEqual([])
    await run(6 * DAY)
    await run(5 * DAY) // same milestone again
    await run(2 * DAY)
    await run(2 * DAY - HOUR)
    await run(HOUR * 20)
    await run(HOUR * 10)
    const rows = await inbox(t.userId, 'subscription.expiring')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.body).sort()).toEqual(['1 day left. Renew to keep your premium placement in search.', '3 days left. Renew to keep your premium placement in search.', '7 days left. Renew to keep your premium placement in search.'])
    expect(rows[0]).toMatchObject({ title: 'Your Premium listing expires soon', deep_link: 'gc://plans', category: 'subscription' })
    await run(-HOUR) // after expiry nothing is sent
    expect(await inbox(t.userId, 'subscription.expiring')).toHaveLength(3)
  })

  it('covers featured listings and teacher plans, and a renewed period starts fresh', async () => {
    const t = await newTeacher()
    const u = new Date('2026-12-01T10:00:00Z')
    await db.updateTable('teachers').set({ is_featured: true, featured_until: u }).where('id', '=', t.teacherId).execute()
    const sub = await db.insertInto('subscriptions').values({ user_id: t.userId, subscriber_type: 'teacher', fee_code: 'TEACHER_REGISTRATION', status: 'active', starts_at: new Date(u.getTime() - 360 * DAY), ends_at: new Date(u.getTime() + HOUR) }).returning('id').executeTakeFirstOrThrow()
    await sendExpiryReminders(new Date(u.getTime() - 6 * DAY))
    const rows = await inbox(t.userId, 'subscription.expiring')
    expect(rows.map((r) => r.title).sort()).toEqual(['Your Featured listing expires soon', 'Your Membership listing expires soon']) // a plan without a price version is called "Membership"
    expect(rows.some((r) => r.dedupe_key === `sub_expiry_7:${sub.id}`)).toBe(true)

    // renewed for another year: the new period is a new key, so its milestones fire again
    const later = new Date(u.getTime() + 300 * DAY)
    await db.updateTable('teachers').set({ featured_until: later }).where('id', '=', t.teacherId).execute()
    await sendExpiryReminders(new Date(later.getTime() - 6 * DAY))
    expect((await inbox(t.userId, 'subscription.expiring')).filter((r) => r.title.includes('Featured'))).toHaveLength(2)
  })

  it('ignores listings that are off or far from expiry', async () => {
    const t = await newTeacher()
    const now = new Date('2027-01-01T10:00:00Z')
    await db.updateTable('teachers').set({ is_premium: false, premium_until: new Date(now.getTime() + 2 * DAY), is_featured: true, featured_until: new Date(now.getTime() + 30 * DAY) }).where('id', '=', t.teacherId).execute()
    await sendExpiryReminders(now)
    expect(await inbox(t.userId, 'subscription.expiring')).toEqual([])
  })
})
