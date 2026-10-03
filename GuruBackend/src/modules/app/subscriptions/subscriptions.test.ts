import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { APP, bearer, createParent, createStudent, createTeacher, loadMasters, purgeUsersByPhone } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestStudent } from '../../../test/appHelpers.js'

const app = createApp()
const phones: string[] = []
let m: Masters
const DAY = 86_400_000

async function newParent(): Promise<TestParent> {
  const p = await createParent(m)
  phones.push(p.phone)
  return p
}
async function newStudent(over: Parameters<typeof createStudent>[1] = {}): Promise<TestStudent> {
  const s = await createStudent(m, over)
  phones.push(s.phone)
  return s
}

type U = { token: string; userId: string }
const get = (u: U, path: string) => request(app).get(`${APP}${path}`).set(bearer(u))
const post = (u: U, path: string, body: object) => request(app).post(`${APP}${path}`).set(bearer(u)).send(body)

type Sub = Partial<{ status: string; feeCode: string; startsAt: Date; endsAt: Date | null; trialEndsAt: Date | null; autoRenew: boolean; createdAt: Date; cancelledBy: string }>
async function addSub(u: U, type: 'parent' | 'student', over: Sub = {}) {
  const feeCode = over.feeCode ?? (type === 'parent' ? 'PARENT_SUBSCRIPTION_MONTHLY' : 'STUDENT_SUBSCRIPTION_MONTHLY')
  return db
    .insertInto('subscriptions')
    .values({
      user_id: u.userId,
      subscriber_type: type,
      fee_code: feeCode,
      status: (over.status ?? 'active') as 'active',
      starts_at: over.startsAt ?? new Date(Date.now() - 5 * DAY),
      ends_at: over.endsAt === undefined ? new Date(Date.now() + 25 * DAY) : over.endsAt,
      trial_ends_at: over.trialEndsAt ?? null,
      auto_renew: over.autoRenew ?? true,
      ...(over.createdAt ? { created_at: over.createdAt } : {}),
      ...(over.cancelledBy ? { cancelled_by_type: over.cancelledBy as 'user' } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

async function setFees(codes: string[], enabled: boolean) {
  await db.updateTable('payment_configurations').set({ is_enabled: enabled }).where('fee_code', 'in', codes).where('status', '=', 'active').execute()
}

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('GET /plans (M10 BR-10.1, M13 BR-13.1)', () => {
  it('lists the parent plans with trial eligibility and the per-month figure', async () => {
    const p = await newParent()
    const res = await get(p, '/plans?role=parent')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([
      { feeCode: 'PARENT_SUBSCRIPTION_MONTHLY', name: expect.any(String), amountPaise: 29900, billingPeriod: 'monthly', validityDays: 30, trialDays: 7, trialEligible: true, perMonthPaise: 29900 },
      { feeCode: 'PARENT_SUBSCRIPTION_YEARLY', name: expect.any(String), amountPaise: 199900, billingPeriod: 'yearly', validityDays: 365, trialDays: 7, trialEligible: true, perMonthPaise: 16658, bestValue: true },
    ])
    expect((await get(p, '/plans')).body.data).toHaveLength(2) // role defaults to the token's
  })

  it('offers no trial to a parent who has had a subscription before (T10.2)', async () => {
    const p = await newParent()
    await addSub(p, 'parent', { status: 'expired', endsAt: new Date(Date.now() - DAY) })
    const res = await get(p, '/plans?role=parent')
    expect(res.body.data.every((plan: { trialEligible: boolean }) => plan.trialEligible === false)).toBe(true)
  })

  it('lists the student plans (T13.1)', async () => {
    const s = await newStudent()
    const res = await get(s, '/plans?role=student')
    expect(res.body.data.map((p: { feeCode: string; amountPaise: number; perMonthPaise: number }) => [p.feeCode, p.amountPaise, p.perMonthPaise])).toEqual([
      ['STUDENT_SUBSCRIPTION_MONTHLY', 19900, 19900],
      ['STUDENT_SUBSCRIPTION_YEARLY', 149900, 12492],
    ])
  })

  it('omits a disabled plan and returns an empty list when both are off (T10.6)', async () => {
    const p = await newParent()
    try {
      await setFees(['PARENT_SUBSCRIPTION_MONTHLY'], false)
      expect((await get(p, '/plans?role=parent')).body.data.map((x: { feeCode: string }) => x.feeCode)).toEqual(['PARENT_SUBSCRIPTION_YEARLY'])
      await setFees(['PARENT_SUBSCRIPTION_YEARLY'], false)
      expect((await get(p, '/plans?role=parent')).body.data).toEqual([])
    } finally {
      await setFees(['PARENT_SUBSCRIPTION_MONTHLY', 'PARENT_SUBSCRIPTION_YEARLY'], true)
    }
  })

  it('rejects a mismatched role, other roles and bad input', async () => {
    const p = await newParent()
    expect((await get(p, '/plans?role=student')).status).toBe(403)
    expect((await get(p, '/plans?role=teacher')).status).toBe(422)
    const t = await createTeacher(m)
    phones.push(t.phone)
    expect((await get(t, '/plans')).status).toBe(403)
    expect((await request(app).get(`${APP}/plans`)).status).toBe(401)
  })
})

describe('GET /subscriptions/current (M10 BR-10.3, M13 BR-13.2, BR-13.4)', () => {
  it('has a defined shape when the user never subscribed', async () => {
    const p = await newParent()
    expect((await get(p, '/subscriptions/current?role=parent')).body.data).toEqual({ id: null, status: 'none', canPurchase: true })
  })

  it('shows a trial with days left and no endsAt', async () => {
    const p = await newParent()
    const trialEnds = new Date(Date.now() + 2.5 * DAY)
    const sub = await addSub(p, 'parent', { status: 'trial', trialEndsAt: trialEnds, endsAt: trialEnds, autoRenew: false })
    const res = await get(p, '/subscriptions/current?role=parent')
    expect(res.body.data).toMatchObject({ id: sub.id, feeCode: 'PARENT_SUBSCRIPTION_MONTHLY', status: 'trial', trialEndsAt: trialEnds.toISOString(), endsAt: null, autoRenew: false, daysLeft: 3, canPurchase: true })
    expect(res.body.data.planName).toBeTruthy()
    expect(res.body.data).not.toHaveProperty('trialContactsUsed')
  })

  it('computes canPurchase from how far away the end is', async () => {
    const far = await newParent()
    await addSub(far, 'parent', { endsAt: new Date(Date.now() + 45 * DAY) })
    expect((await get(far, '/subscriptions/current?role=parent')).body.data.canPurchase).toBe(false)
    const near = await newParent()
    await addSub(near, 'parent', { endsAt: new Date(Date.now() + 10 * DAY) })
    expect((await get(near, '/subscriptions/current?role=parent')).body.data).toMatchObject({ status: 'active', canPurchase: true, daysLeft: 10 })
    const free = await newParent()
    await addSub(free, 'parent', { status: 'free_access', endsAt: null })
    expect((await get(free, '/subscriptions/current?role=parent')).body.data).toMatchObject({ status: 'free_access', endsAt: null, daysLeft: null, canPurchase: false })
  })

  it('prefers the live row, otherwise the most recent one, and never shows other users\' rows', async () => {
    const p = await newParent()
    const old = await addSub(p, 'parent', { status: 'expired', endsAt: new Date(Date.now() - 30 * DAY), startsAt: new Date(Date.now() - 60 * DAY), createdAt: new Date(Date.now() - 60 * DAY) })
    const recent = await addSub(p, 'parent', { status: 'cancelled', endsAt: new Date(Date.now() - 2 * DAY), startsAt: new Date(Date.now() - 20 * DAY), createdAt: new Date(Date.now() - 20 * DAY) })
    let res = await get(p, '/subscriptions/current?role=parent')
    expect(res.body.data.id).toBe(recent.id)
    expect(res.body.data.id).not.toBe(old.id)
    const live = await addSub(p, 'parent', { status: 'active' })
    res = await get(p, '/subscriptions/current?role=parent')
    expect(res.body.data.id).toBe(live.id)
    const other = await newParent()
    expect((await get(other, '/subscriptions/current?role=parent')).body.data.status).toBe('none')
  })

  it('counts a student\'s trial contacts live from leads (T13.1)', async () => {
    const s = await newStudent()
    const t = await createTeacher(m)
    phones.push(t.phone)
    const trialEnds = new Date(Date.now() + 2 * DAY)
    await addSub(s, 'student', { status: 'trial', trialEndsAt: trialEnds, endsAt: trialEnds, startsAt: new Date(Date.now() - DAY) })
    for (let i = 0; i < 3; i++) {
      await db.insertInto('leads').values({ lead_type: 'inquiry', target_type: 'teacher', teacher_id: t.teacherId, requester_user_id: s.userId, requester_type: 'student' } as never).execute()
    }
    // a lead from before the trial started does not count
    await db.insertInto('leads').values({ lead_type: 'inquiry', target_type: 'teacher', teacher_id: t.teacherId, requester_user_id: s.userId, requester_type: 'student', created_at: new Date(Date.now() - 3 * DAY) } as never).execute()
    const res = await get(s, '/subscriptions/current?role=student')
    expect(res.body.data).toMatchObject({ status: 'trial', trialContactsUsed: 3, trialContactsLimit: 5, canPurchase: true })
  })

  it('reports covered_by_parent with the parent\'s first name only, and falls back when the plan lapses (T13.2, T13.3)', async () => {
    const parent = await newParent()
    const parentSub = await addSub(parent, 'parent', { feeCode: 'PARENT_SUBSCRIPTION_YEARLY', endsAt: new Date(Date.now() + 200 * DAY) })
    const s = await newStudent({ parentId: parent.parentId, parentLinkStatus: 'confirmed' })
    const res = await get(s, '/subscriptions/current?role=student')
    expect(res.body.data).toMatchObject({ status: 'covered_by_parent', canPurchase: false, coveredBy: { parentId: parent.parentId, parentName: 'Lakshmi' } })
    expect(res.body.data.coveredBy.planName).toBeTruthy()
    expect(JSON.stringify(res.body)).not.toContain('Venkatesh')
    expect(JSON.stringify(res.body)).not.toContain(parent.phone)

    await db.updateTable('subscriptions').set({ status: 'expired' }).where('id', '=', parentSub.id).execute()
    expect((await get(s, '/subscriptions/current?role=student')).body.data.status).toBe('none')

    const pending = await newStudent({ parentId: parent.parentId, parentLinkStatus: 'pending' })
    await db.updateTable('subscriptions').set({ status: 'active' }).where('id', '=', parentSub.id).execute()
    expect((await get(pending, '/subscriptions/current?role=student')).body.data.status).toBe('none') // only a confirmed link covers
  })

  it('rejects a mismatched role', async () => {
    const s = await newStudent()
    expect((await get(s, '/subscriptions/current?role=parent')).status).toBe(403)
  })
})

describe('POST /subscriptions/:id/auto-renew (BR-10.5)', () => {
  it('turns auto-renew off, audited, and keeps access', async () => {
    const p = await newParent()
    const ends = new Date(Date.now() + 25 * DAY)
    const sub = await addSub(p, 'parent', { autoRenew: true, endsAt: ends })
    const res = await post(p, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: sub.id, status: 'active', cancelledAt: null, endsAt: ends.toISOString(), autoRenew: false })
    expect(res.body.data.message).toMatch(/^You'll keep access until \d{1,2} \w+ \d{4}\.$/)
    expect((await db.selectFrom('subscriptions').select('auto_renew').where('id', '=', sub.id).executeTakeFirstOrThrow()).auto_renew).toBe(false)
    const audit = await db.selectFrom('audit_logs').select('module').where('actor_id', '=', p.userId).where('action', '=', 'app.subscription_auto_renew_disabled').execute()
    expect(audit).toHaveLength(1)
  })

  it('cannot turn it on, and only works on a live plan the caller owns', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent')
    expect((await post(p, `/subscriptions/${sub.id}/auto-renew`, { enabled: true })).status).toBe(422)
    expect((await post(p, `/subscriptions/${sub.id}/auto-renew`, {})).status).toBe(422)

    const stranger = await newParent()
    const notFound = await post(stranger, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })
    expect(notFound.status).toBe(404)
    expect(notFound.body.error.code).toBe('NOT_FOUND')
    expect((await post(p, `/subscriptions/${randomUUID()}/auto-renew`, { enabled: false })).status).toBe(404)
    expect((await post(p, '/subscriptions/nope/auto-renew', { enabled: false })).status).toBe(422)
  })

  it('answers CONFLICT_STATE on a plan that is not live', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent', { status: 'expired', endsAt: new Date(Date.now() - DAY) })
    const res = await post(p, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_STATE')
  })

  it('is scoped to the caller\'s role (a parent cannot touch a student subscription)', async () => {
    const s = await newStudent()
    const sub = await addSub(s, 'student')
    expect((await post(s, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })).status).toBe(200)
    const p = await newParent()
    expect((await post(p, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })).status).toBe(404)
  })
})

describe('POST /subscriptions/:id/cancel (BR-10.6)', () => {
  it('cancels at period end: access stays, auto-renew off, reason stored (T10.3)', async () => {
    const p = await newParent()
    const ends = new Date(Date.now() + 20 * DAY)
    const sub = await addSub(p, 'parent', { endsAt: ends })
    const res = await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end', reason: 'Found a teacher through a friend' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: sub.id, status: 'active', cancelledAt: null, endsAt: ends.toISOString(), autoRenew: false })
    expect(res.body.data.message).toMatch(/^You'll keep access until /)
    const row = await db.selectFrom('subscriptions').select(['status', 'cancel_reason', 'cancelled_by_type']).where('id', '=', sub.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'active', cancel_reason: 'Found a teacher through a friend', cancelled_by_type: 'user' })
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', p.userId).where('action', '=', 'app.subscription_cancel_requested').executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ mode: 'at_period_end' })
  })

  it('cancels immediately inside the first 24 hours', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent', { startsAt: new Date(Date.now() - 2 * 3_600_000) })
    const res = await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'immediately' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'cancelled', autoRenew: false })
    expect(res.body.data.cancelledAt).toBeTruthy()
    expect(res.body.data.message).toBe('Your membership has been cancelled.')
    expect((await get(p, '/subscriptions/current?role=parent')).body.data.status).toBe('cancelled')
  })

  it('refuses an immediate cancel after 24 hours but allows period end (T10.4)', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent', { startsAt: new Date(Date.now() - 25 * 3_600_000) })
    const res = await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'immediately' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'You can only cancel immediately within 24 hours of subscribing.', details: { path: 'mode' } })
    expect((await db.selectFrom('subscriptions').select('status').where('id', '=', sub.id).executeTakeFirstOrThrow()).status).toBe('active')
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })).status).toBe(200)
  })

  it('a second cancel from another device is CONFLICT_STATE (T10.9)', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent')
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })).status).toBe(200)
    const again = await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('CONFLICT_STATE')

    const q = await newParent()
    const imm = await addSub(q, 'parent', { startsAt: new Date(Date.now() - 3_600_000) })
    await post(q, `/subscriptions/${imm.id}/cancel`, { mode: 'immediately' })
    expect((await post(q, `/subscriptions/${imm.id}/cancel`, { mode: 'at_period_end' })).status).toBe(409)
  })

  it('cannot cancel an expired plan', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent', { status: 'expired', endsAt: new Date(Date.now() - DAY) })
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })).status).toBe(409)
  })

  it('masks contact details pasted into the reason', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent')
    await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end', reason: 'call me on 9845012345 or mail a@b.com' })
    const row = await db.selectFrom('subscriptions').select('cancel_reason').where('id', '=', sub.id).executeTakeFirstOrThrow()
    expect(row.cancel_reason).not.toMatch(/9845012345|a@b\.com/)
    expect(row.cancel_reason).toContain('[hidden]')
  })

  it('validates the body and ownership', async () => {
    const p = await newParent()
    const sub = await addSub(p, 'parent')
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'whenever' })).status).toBe(422)
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, {})).status).toBe(422)
    expect((await post(p, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end', reason: 'x'.repeat(301) })).status).toBe(422)
    const stranger = await newParent()
    expect((await post(stranger, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })).status).toBe(404)
    expect((await request(app).post(`${APP}/subscriptions/${sub.id}/cancel`).send({ mode: 'at_period_end' })).status).toBe(401)
    expect((await get(p, '/subscriptions/current')).status).toBe(200)
  })

  it('works the same for students (T13.7)', async () => {
    const s = await newStudent()
    const sub = await addSub(s, 'student')
    expect((await post(s, `/subscriptions/${sub.id}/auto-renew`, { enabled: false })).status).toBe(200)
    expect((await post(s, `/subscriptions/${sub.id}/cancel`, { mode: 'at_period_end' })).status).toBe(200)
  })
})
