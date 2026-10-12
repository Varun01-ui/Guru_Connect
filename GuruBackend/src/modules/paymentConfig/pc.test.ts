import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db } from '../../db/index.js'
import { resolveFee } from '../../lib/pricing.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { activateDueVersions, purgePricingCache } from './pc.actions.js'
import { FEE_CODES } from './pc.rules.js'

const app = createApp()
const EMAIL_PREFIX = 'pc-test'
const RUN = randomUUID().slice(0, 6)
const APP_API = '/api/v1/app'
const DAY = 86_400_000

// The fees the publishing tests change. The payment suites rely on the others staying exactly as seeded.
const PREMIUM = 'PREMIUM_TEACHER'
const FEATURED = 'FEATURED_TEACHER'
const CONTACT = 'CONTACT_UNLOCK'
const PARENT_MONTHLY = 'PARENT_SUBSCRIPTION_MONTHLY'
const PARENT_YEARLY = 'PARENT_SUBSCRIPTION_YEARLY'
const TOUCHED = [PREMIUM, FEATURED, CONTACT, PARENT_MONTHLY, PARENT_YEARLY]

let superAdmin: TestAdmin
let finance: TestAdmin // read + edit + publish
let ops: TestAdmin // read only
let maker: TestAdmin // read + edit, cannot publish
let outsider: TestAdmin // verification admin: nothing

type Body = Record<string, unknown>
type Version = { id: string; feeCode: string; version: number; status: string; amountPaise: number; isEnabled: boolean; updatedAt: string; effectiveFrom: string; effectiveTo: string | null; billingPeriod: string; validityDays: number | null; trialDays: number; name: string; changeReason: string | null; publishedBy: { id: string } | null }
type Fee = { active: Version | null; scheduled: Version | null; draft: Version | null; changed?: Version }

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
const get = (a: { token: string }, path: string) => request(app).get(`${API}${path}`).set(authed(a.token))
const send = (method: 'post' | 'put' | 'delete', a: { token: string }, path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app)[method](`${API}${path}`).set(authed(a.token)).set(headers).send(body)

const fee = async (code: string) => (await get(finance, `/payment-configs/${code}`)).body.data as Fee & { versions: Version[] }
const putDraft = async (code: string, body: Body, as: TestAdmin = finance) => {
  const draft = (await fee(code)).draft
  return send('put', as, `/payment-configs/${code}/draft`, body, draft ? { 'If-Match': draft.updatedAt } : {})
}
const makeDraft = async (code: string, body: Body = {}) => {
  const res = await putDraft(code, body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as Version
}
const publish = (code: string, body: Body = {}, as: TestAdmin = finance) => send('post', as, `/payment-configs/${code}/draft/publish`, { reason: 'Test price change', ...body }, {})
const toggle = (code: string, enabled: boolean, reason: string | undefined = 'Test switch') => send('post', finance, `/payment-configs/${code}/toggle`, { enabled, reason })
const pricing = async () => (await request(app).get(`${APP_API}/pricing`)).body.data as Record<string, { enabled: boolean; amountPaise?: number }>
const actionsOf = async (versionId: string) => (await db.selectFrom('payment_configuration_history').select('action').where('payment_configuration_id', '=', versionId).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
const auditActions = async (id: string) => (await db.selectFrom('audit_logs').select('action').where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)

// ---- baseline: put everything back the way the seed left it ----
let baselineRows: Awaited<ReturnType<typeof snapshotRows>> = []
let baselineHistory = new Set<string>()
const snapshotRows = () => db.selectFrom('payment_configurations').selectAll().where('fee_code', 'in', TOUCHED).execute()

async function resetFees() {
  const keep = baselineRows.map((r) => r.id)
  const hist = (await db.selectFrom('payment_configuration_history').select('id').where('fee_code', 'in', TOUCHED).execute()).map((h) => h.id).filter((id) => !baselineHistory.has(id))
  if (hist.length) await db.deleteFrom('payment_configuration_history').where('id', 'in', hist).execute()
  const extra = (await db.selectFrom('payment_configurations').select('id').where('fee_code', 'in', TOUCHED).where('id', 'not in', keep).execute()).map((r) => r.id)
  if (extra.length) {
    await db.deleteFrom('payment_configuration_history').where('payment_configuration_id', 'in', extra).execute()
    await db.deleteFrom('payment_configurations').where('id', 'in', extra).execute()
  }
  // Restoring statuses one by one: moving a row to 'active' while another still is would trip the unique index.
  for (const r of baselineRows.filter((b) => b.status !== 'active')) {
    await db.updateTable('payment_configurations').set({ status: r.status, effective_to: r.effective_to }).where('id', '=', r.id).execute()
  }
  for (const r of baselineRows.filter((b) => b.status === 'active')) {
    const { id, created_at, updated_at, ...rest } = r
    void created_at
    void updated_at
    await db.updateTable('payment_configurations').set(rest as never).where('id', '=', id).execute()
  }
  await purgePricingCache()
}

beforeAll(async () => {
  baselineRows = await snapshotRows()
  baselineHistory = new Set((await db.selectFrom('payment_configuration_history').select('id').where('fee_code', 'in', TOUCHED).execute()).map((h) => h.id))
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX })
  finance = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX, fullName: 'Farah Khan' })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ roles: ['verification_admin'], emailPrefix: EMAIL_PREFIX })
  const role = await db.insertInto('roles').values({ code: `rbac_test_pc_maker_${RUN}`, name: `RBAC Test Maker ${RUN}` }).returning('id').executeTakeFirstOrThrow()
  await db.insertInto('role_permissions').columns(['role_id', 'permission_id']).expression((eb) => eb.selectFrom('permissions').select([eb.val(role.id).as('role_id'), 'id']).where('key', 'in', ['payment_config.read', 'payment_config.edit'])).execute()
  maker = await createAdminWithToken({ roles: [`rbac_test_pc_maker_${RUN}`], emailPrefix: EMAIL_PREFIX })
})

beforeEach(resetFees)

afterAll(async () => {
  await resetFees()
  await purgeRbacFixtures(EMAIL_PREFIX)
})

describe('permissions (maker–checker)', () => {
  it('needs a signed-in admin', async () => {
    expect((await request(app).get(`${API}/payment-configs`)).status).toBe(401)
    expect((await request(app).put(`${API}/payment-configs/${PREMIUM}/draft`).send({})).status).toBe(401)
  })

  it('lets read-only admins look but not change anything', async () => {
    expect((await get(ops, '/payment-configs')).status).toBe(200)
    expect((await get(ops, `/payment-configs/${PREMIUM}`)).status).toBe(200)
    expect((await get(ops, '/payment-configs/history')).status).toBe(200)
    const draft = await send('put', ops, `/payment-configs/${PREMIUM}/draft`, { amountPaise: 100 })
    expect(draft.status).toBe(403)
    expect(draft.body.error.details.required).toEqual(['payment_config.edit'])
    for (const [method, path] of [
      ['post', `/payment-configs/${PREMIUM}/draft/publish`],
      ['post', `/payment-configs/${PREMIUM}/toggle`],
      ['post', `/payment-configs/versions/${randomUUID()}/cancel`],
      ['post', `/payment-configs/versions/${randomUUID()}/restore`],
    ] as const) {
      const res = await send(method, ops, path, { reason: 'Because', enabled: false })
      expect(res.status, path).toBe(403)
      expect(res.body.error.details.required).toEqual(['payment_config.publish'])
    }
  })

  it('refuses an admin with no payment permission', async () => {
    expect((await get(outsider, '/payment-configs')).status).toBe(403)
    expect((await get(outsider, '/payment-configs/history')).status).toBe(403)
  })

  it('a maker can prepare a draft but only a publisher can put it live', async () => {
    const saved = await putDraft(PREMIUM, { amountPaise: 109900 }, maker)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const denied = await publish(PREMIUM, {}, maker)
    expect(denied.status).toBe(403)
    expect((await fee(PREMIUM)).active!.amountPaise).toBe(99900)
    const ok = await publish(PREMIUM, {}, superAdmin)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.active.amountPaise).toBe(109900)
  })
})

describe('reading', () => {
  it('lists the nine fees in a fixed order, each with its live version', async () => {
    const res = await get(finance, '/payment-configs')
    expect(res.status).toBe(200)
    expect(res.body.data.map((f: { feeCode: string }) => f.feeCode)).toEqual([...FEE_CODES])
    for (const f of res.body.data) {
      expect(f.active, f.feeCode).toMatchObject({ status: 'active', version: expect.any(Number), amountPaise: expect.any(Number) })
      expect(f.usage30d).toEqual({ captured: expect.any(Number), revenuePaise: expect.any(Number) })
    }
    const premium = res.body.data.find((f: { feeCode: string }) => f.feeCode === PREMIUM)
    expect(premium.active).toMatchObject({ amountPaise: 99900, billingPeriod: 'per_30_days', validityDays: 30, isEnabled: true })
    expect(premium.scheduled).toBeNull()
    expect(premium.draft).toBeNull()
  })

  it('returns one fee with its version history, paginated and filterable', async () => {
    await makeDraft(PREMIUM, { amountPaise: 105000 })
    await publish(PREMIUM)
    await makeDraft(PREMIUM, { amountPaise: 110000 })
    await publish(PREMIUM)
    const all = await get(finance, `/payment-configs/${PREMIUM}`)
    expect(all.body.data.versions.map((v: Version) => v.status)).toEqual(['active', 'superseded', 'superseded'])
    expect(all.body.data.versions.map((v: Version) => v.version)).toEqual([3, 2, 1])
    expect(all.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 3, totalPages: 1 })
    const page = await get(finance, `/payment-configs/${PREMIUM}?pageSize=2&page=2`)
    expect(page.body.data.versions).toHaveLength(1)
    const old = await get(finance, `/payment-configs/${PREMIUM}?status=superseded`)
    expect(old.body.data.versions).toHaveLength(2)
    expect(old.body.meta.total).toBe(2)
    expect((await get(finance, `/payment-configs/${PREMIUM}?status=weird`)).status).toBe(422)
  })

  it('answers 404 for an unknown fee code', async () => {
    for (const path of ['/payment-configs/NOPE', '/payment-configs/NOPE/draft/preview']) {
      const res = await get(finance, path)
      expect(res.status, path).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Fee not found.' })
    }
    expect((await send('put', finance, '/payment-configs/NOPE/draft', {})).status).toBe(404)
    expect((await send('delete', finance, '/payment-configs/NOPE/draft')).status).toBe(404)
    expect((await send('post', finance, '/payment-configs/NOPE/toggle', { enabled: false, reason: 'Because' })).status).toBe(404)
    expect((await send('post', finance, '/payment-configs/NOPE/draft/publish', { reason: 'Because' })).status).toBe(404)
  })
})

describe('drafts', () => {
  it('creates the draft as a copy of the live version with the next version number', async () => {
    const d = await makeDraft(PREMIUM, { amountPaise: 109900, name: 'Premium listing plus' })
    expect(d).toMatchObject({ status: 'draft', version: 2, amountPaise: 109900, name: 'Premium listing plus', billingPeriod: 'per_30_days', validityDays: 30, isEnabled: true })
    const state = await fee(PREMIUM)
    expect(state.active!.amountPaise).toBe(99900) // the live version is untouched
    expect(state.draft!.id).toBe(d.id)
    expect(await auditActions(d.id)).toEqual(['payment_config.draft_saved'])
    expect(await actionsOf(d.id)).toEqual([]) // drafts leave no change-history rows
  })

  it('an empty body creates an unchanged copy', async () => {
    const d = await makeDraft(FEATURED)
    expect(d.amountPaise).toBe(149900)
  })

  it('applies later saves on top of the draft, and needs the draft’s If-Match once it exists', async () => {
    const first = await makeDraft(PREMIUM, { amountPaise: 105000 })
    expect((await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { trialDays: 0 })).status).toBe(422) // no If-Match
    await new Promise((r) => setTimeout(r, 15))
    const second = await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { description: 'Top spots for 30 days' }, { 'If-Match': first.updatedAt })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.data).toMatchObject({ id: first.id, amountPaise: 105000, description: 'Top spots for 30 days' })
    expect(new Date(second.body.data.updatedAt).getTime()).toBeGreaterThan(new Date(first.updatedAt).getTime())
    expect((await fee(PREMIUM)).versions.filter((v) => v.status === 'draft')).toHaveLength(1)
  })

  it('does not move updatedAt when a save changes nothing', async () => {
    const first = await makeDraft(PREMIUM, { amountPaise: 105000 })
    const again = await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { amountPaise: 105000 }, { 'If-Match': first.updatedAt })
    expect(again.status).toBe(200)
    expect(again.body.data.updatedAt).toBe(first.updatedAt)
  })

  it('refuses a draft edited in another tab (409)', async () => {
    const first = await makeDraft(PREMIUM, { amountPaise: 105000 })
    await new Promise((r) => setTimeout(r, 15))
    await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { amountPaise: 106000 }, { 'If-Match': first.updatedAt })
    const stale = await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { amountPaise: 107000 }, { 'If-Match': first.updatedAt })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'This draft changed in another tab.' })
    expect(stale.body.error.details.current.amountPaise).toBe(106000)
  })

  it('writes one audit row per ten minutes of autosaving, not one per keystroke', async () => {
    const d = await makeDraft(PREMIUM, { amountPaise: 101000 })
    let version = d.updatedAt
    for (const amountPaise of [102000, 103000, 104000]) {
      await new Promise((r) => setTimeout(r, 5))
      const res = await send('put', finance, `/payment-configs/${PREMIUM}/draft`, { amountPaise }, { 'If-Match': version })
      version = res.body.data.updatedAt
    }
    const actions = await auditActions(d.id)
    expect(actions.filter((a) => a === 'payment_config.draft_saved')).toHaveLength(2) // creation + first edit
  })

  it.each([
    ['yearly plan on a monthly period', PARENT_YEARLY, { billingPeriod: 'monthly', validityDays: 30 }, 'billingPeriod', 'Yearly plans must use a yearly period.'],
    ['monthly plan on a yearly period', PARENT_MONTHLY, { billingPeriod: 'yearly', validityDays: 365 }, 'billingPeriod', 'Monthly plans must use a monthly period.'],
    ['listing on a monthly period', PREMIUM, { billingPeriod: 'monthly', validityDays: 30 }, 'billingPeriod', 'Listings are charged every 30 days.'],
    ['contact unlock on a yearly period', CONTACT, { billingPeriod: 'yearly', validityDays: 365 }, 'billingPeriod', 'Contact unlock is charged per use.'],
    ['monthly validity of 40 days', PARENT_MONTHLY, { validityDays: 40 }, 'validityDays', 'Monthly plans last 28–31 days.'],
    ['yearly validity of 300 days', PARENT_YEARLY, { validityDays: 300 }, 'validityDays', 'Yearly plans last 365 or 366 days.'],
    ['listing validity of 31 days', PREMIUM, { validityDays: 31 }, 'validityDays', 'This listing lasts 30 days.'],
    ['validity above 1,095 days', PREMIUM, { validityDays: 2000 }, 'validityDays', 'Validity must be 1–1,095 days.'],
    ['missing validity', PREMIUM, { validityDays: null }, 'validityDays', 'Enter how many days the purchase lasts.'],
    ['a validity on a per-use fee', CONTACT, { validityDays: 30 }, 'validityDays', 'Contact unlock has no validity period.'],
    ['a trial on a listing', PREMIUM, { trialDays: 7 }, 'trialDays', 'Only membership plans can have a free trial.'],
    ['a 91 day trial', PARENT_MONTHLY, { trialDays: 91 }, 'trialDays', 'Trial must be 0–90 days.'],
    ['a negative trial', PARENT_MONTHLY, { trialDays: -1 }, 'trialDays', 'Trial must be 0–90 days.'],
    ['a price above ₹1,00,000', PREMIUM, { amountPaise: 10_000_001 }, 'amountPaise', 'Price must be between ₹0 and ₹1,00,000.'],
    ['a negative price', PREMIUM, { amountPaise: -1 }, 'amountPaise', 'Price must be between ₹0 and ₹1,00,000.'],
    ['a fractional price', PREMIUM, { amountPaise: 999.5 }, 'amountPaise', 'Price must be a whole number of paise.'],
    ['a price as text', PREMIUM, { amountPaise: '999' }, 'amountPaise', 'Price must be a whole number of paise.'],
    ['GST of 10%', PREMIUM, { gstRateBps: 1000 }, 'gstRateBps', 'GST must be 0%, 5%, 12%, 18% or 28%.'],
    ['a name of two letters', PREMIUM, { name: 'ab' }, 'name', 'Name must be 3–60 characters.'],
    ['a 61 character name', PREMIUM, { name: 'x'.repeat(61) }, 'name', 'Name must be 3–60 characters.'],
    ['a 201 character description', PREMIUM, { description: 'x'.repeat(201) }, 'description', 'Description can be up to 200 characters.'],
    ['an unknown billing period', PREMIUM, { billingPeriod: 'weekly' }, 'billingPeriod', 'Choose a billing period.'],
  ])('rejects %s (422)', async (_label, code, body, path, message) => {
    const res = await putDraft(code, body)
    expect(res.status, JSON.stringify(res.body)).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details[0]).toEqual({ path, message })
    expect((await fee(code)).draft).toBeNull()
  })

  it('rejects unknown fields', async () => {
    expect((await putDraft(PREMIUM, { status: 'active' })).status).toBe(422)
    expect((await putDraft(PREMIUM, { effectiveFrom: iso(0) })).status).toBe(422)
  })

  it('accepts a free trial on membership plans, and the GST and period options', async () => {
    const d = await makeDraft(PARENT_YEARLY, { trialDays: 14, gstRateBps: 1200, gstInclusive: false, validityDays: 366 })
    expect(d).toMatchObject({ trialDays: 14, validityDays: 366 })
    const reg = await makeDraft('TEACHER_REGISTRATION', { billingPeriod: 'one_time', validityDays: 730 })
    expect(reg).toMatchObject({ billingPeriod: 'one_time', validityDays: 730 })
    await send('delete', finance, '/payment-configs/TEACHER_REGISTRATION/draft')
  })

  it('discards a draft, once', async () => {
    const d = await makeDraft(PREMIUM, { amountPaise: 105000 })
    const res = await send('delete', finance, `/payment-configs/${PREMIUM}/draft`)
    expect(res.status).toBe(204)
    expect((await fee(PREMIUM)).draft).toBeNull()
    expect(await db.selectFrom('payment_configurations').select('id').where('id', '=', d.id).executeTakeFirst()).toBeUndefined()
    expect((await db.selectFrom('audit_logs').select('action').where('entity_id', '=', d.id).where('action', '=', 'payment_config.draft_discarded').executeTakeFirst())).toBeTruthy()
    const again = await send('delete', finance, `/payment-configs/${PREMIUM}/draft`)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('CONFLICT_STATE')
    // A new draft after a discard works.
    expect((await putDraft(PREMIUM, { amountPaise: 106000 })).status).toBe(200)
  })

  it('gives the next version number again after a discard', async () => {
    await makeDraft(PREMIUM)
    await send('delete', finance, `/payment-configs/${PREMIUM}/draft`)
    expect((await makeDraft(PREMIUM)).version).toBe(2)
  })
})

describe('preview', () => {
  it('renders the price card the app will show, and the impact of publishing', async () => {
    await makeDraft(PARENT_YEARLY, { amountPaise: 179900, trialDays: 7 })
    const res = await get(finance, `/payment-configs/${PARENT_YEARLY}/draft/preview`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.card).toEqual({
      title: 'Parent membership · Yearly',
      priceText: '₹1,799 / year',
      perMonthText: '₹150 / month',
      gstText: 'incl. ₹274 GST',
      trialText: '7-day free trial',
      enabled: true,
    })
    expect(res.body.data.impact).toEqual({ liveSubscriptionsOnCurrentVersion: expect.any(Number), openCheckouts: expect.any(Number), changePercent: -10 })
  })

  it('shows GST added on top, no trial text and paise when there are paise', async () => {
    await makeDraft(PREMIUM, { amountPaise: 99950, gstInclusive: false, gstRateBps: 1800, isEnabled: false })
    const { card } = (await get(finance, `/payment-configs/${PREMIUM}/draft/preview`)).body.data
    expect(card).toMatchObject({ priceText: '₹999.50 / 30 days', perMonthText: null, gstText: '+ ₹180 GST', trialText: null, enabled: false })
  })

  it('counts live subscriptions on the current version and open checkouts', async () => {
    await makeDraft(PARENT_MONTHLY, { amountPaise: 39900 })
    const before = (await get(finance, `/payment-configs/${PARENT_MONTHLY}/draft/preview`)).body.data.impact
    expect(before.changePercent).toBeCloseTo(33.4, 1)
    expect(before.liveSubscriptionsOnCurrentVersion).toBeGreaterThanOrEqual(0)
  })

  it('has nothing to preview without a draft (409)', async () => {
    const res = await get(finance, `/payment-configs/${PREMIUM}/draft/preview`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "There's no draft to preview." })
  })
})

describe('publishing now', () => {
  it('puts the draft live as the next version and retires the old one', async () => {
    const before = (await fee(PREMIUM)).active!
    const draft = await makeDraft(PREMIUM, { amountPaise: 109900 })
    const res = await publish(PREMIUM, { reason: 'Diwali pricing' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { active, draft: left, scheduled } = res.body.data as Fee
    expect(active).toMatchObject({ id: draft.id, status: 'active', version: 2, amountPaise: 109900, changeReason: 'Diwali pricing', publishedBy: { id: finance.id, name: 'Farah Khan' } })
    expect(left).toBeNull()
    expect(scheduled).toBeNull()

    const old = (await fee(PREMIUM)).versions.find((v) => v.id === before.id)!
    expect(old.status).toBe('superseded')
    expect(old.effectiveTo).not.toBeNull()
    expect(new Date(old.effectiveTo!).getTime()).toBe(new Date(active!.effectiveFrom).getTime())

    expect(await actionsOf(before.id)).toEqual(expect.arrayContaining(['superseded']))
    expect(await actionsOf(draft.id)).toEqual(['published'])
    const entry = await db.selectFrom('audit_logs').selectAll().where('entity_id', '=', draft.id).where('action', '=', 'payment_config.published').executeTakeFirstOrThrow()
    expect(entry).toMatchObject({ actor_id: finance.id, reason: 'Diwali pricing' })
    expect(entry.old_values).toMatchObject({ amountPaise: 99900, isEnabled: true })
    expect(entry.new_values).toMatchObject({ feeCode: PREMIUM, version: 2, amountPaise: 109900 })
  })

  it('is what resolveFee returns straight away', async () => {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await publish(PREMIUM)
    const resolved = await resolveFee(PREMIUM)
    expect(Number(resolved!.amount_paise)).toBe(109900)
  })

  it('shows up in the app’s pricing endpoint at once, because publishing purges its cache', async () => {
    expect((await pricing())[PREMIUM]!.amountPaise).toBe(99900) // fills the cache
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await publish(PREMIUM)
    expect((await pricing())[PREMIUM]!.amountPaise).toBe(109900)
  })

  it('treats a time within a minute of now as now', async () => {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    const res = await publish(PREMIUM, { effectiveFrom: iso(30_000) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.active.amountPaise).toBe(109900)
    expect(res.body.data.scheduled).toBeNull()
  })

  it('needs a draft (409) and a reason (422)', async () => {
    const none = await publish(PREMIUM)
    expect(none.status).toBe(409)
    expect(none.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: "There's no draft to publish." })
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    for (const reason of [undefined, '', '   ', 'no']) {
      const res = await send('post', finance, `/payment-configs/${PREMIUM}/draft/publish`, reason === undefined ? {} : { reason })
      expect(res.status, String(reason)).toBe(422)
      expect(res.body.error.details[0]).toEqual({ path: 'reason', message: 'Add a reason.' })
    }
    expect((await fee(PREMIUM)).active!.amountPaise).toBe(99900)
  })

  it('refuses to put a paid fee live at ₹0 (422), but lets a membership with a trial through', async () => {
    await makeDraft(PREMIUM, { amountPaise: 0 })
    const res = await publish(PREMIUM)
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('amountPaise')
    await send('delete', finance, `/payment-configs/${PREMIUM}/draft`)
    // Switching it off first makes a ₹0 price legitimate.
    await makeDraft(PREMIUM, { amountPaise: 0, isEnabled: false })
    expect((await publish(PREMIUM, { confirmLargeChange: true })).status).toBe(200)

    await makeDraft(PARENT_MONTHLY, { amountPaise: 0, trialDays: 30 })
    expect((await publish(PARENT_MONTHLY, { confirmLargeChange: true })).status).toBe(200)
  })

  it('asks for confirmation when the price moves by more than 50%', async () => {
    await makeDraft(PREMIUM, { amountPaise: 199800 })
    const res = await publish(PREMIUM)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.message).toBe("This is a 100% change. Confirm it's intended.")
    expect((await fee(PREMIUM)).active!.amountPaise).toBe(99900)
    const ok = await publish(PREMIUM, { confirmLargeChange: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data.active.amountPaise).toBe(199800)
  })

  it('treats exactly 50% as fine, and a drop of more than 50% as large too', async () => {
    await makeDraft(PREMIUM, { amountPaise: 149850 })
    expect((await publish(PREMIUM)).status).toBe(200)
    await makeDraft(PREMIUM, { amountPaise: 50000 })
    const res = await publish(PREMIUM)
    expect(res.status).toBe(422)
    expect(res.body.error.message).toBe("This is a 67% change. Confirm it's intended.")
  })

  it('re-checks the whole version at publish time', async () => {
    await makeDraft(PARENT_YEARLY, { trialDays: 7 })
    await db.updateTable('payment_configurations').set({ validity_days: 100 }).where('fee_code', '=', PARENT_YEARLY).where('status', '=', 'draft').execute()
    const res = await publish(PARENT_YEARLY)
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('validityDays')
  })

  it('lets only one of two simultaneous publishes win', async () => {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    const [a, b] = await Promise.all([publish(PREMIUM), publish(PREMIUM)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const state = await fee(PREMIUM)
    expect(state.versions.filter((v) => v.status === 'active')).toHaveLength(1)
    expect(state.active!.amountPaise).toBe(109900)
  })
})

describe('scheduling', () => {
  const schedule = async (code: string, body: Body, days = 3, extra: Body = {}) => {
    await makeDraft(code, body)
    return publish(code, { effectiveFrom: iso(days * DAY), ...extra })
  }

  it('keeps the live price until the time comes, and leaves the draft slot free', async () => {
    const res = await schedule(PREMIUM, { amountPaise: 109900 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.scheduled).toMatchObject({ status: 'scheduled', version: 2, amountPaise: 109900 })
    expect(res.body.data.active.amountPaise).toBe(99900)
    expect(res.body.data.draft).toBeNull()
    expect(Number((await resolveFee(PREMIUM))!.amount_paise)).toBe(99900)
    expect((await pricing())[PREMIUM]!.amountPaise).toBe(99900)
    const state = await fee(PREMIUM)
    expect(state.scheduled!.effectiveFrom).toBe(res.body.data.scheduled.effectiveFrom)
    expect(await actionsOf(res.body.data.scheduled.id)).toEqual(['scheduled'])
    expect(await auditActions(res.body.data.scheduled.id)).toContain('payment_config.scheduled')
    // The live version has not been touched yet.
    expect(state.active!.effectiveTo).toBeNull()
  })

  it('allows a draft to be prepared while a change is already scheduled, but not a second schedule (409)', async () => {
    const first = await schedule(PREMIUM, { amountPaise: 109900 })
    await makeDraft(PREMIUM, { amountPaise: 119900 })
    const second = await publish(PREMIUM, { effectiveFrom: iso(10 * DAY) })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('CONFLICT_STATE')
    expect(second.body.error.message).toMatch(/^Cancel the change scheduled for .+ first\.$/)
    expect(second.body.error.details.scheduledVersionId).toBe(first.body.data.scheduled.id)
  })

  it('does not let an immediate publish or a switch-off run over a pending schedule (409)', async () => {
    await schedule(PREMIUM, { amountPaise: 109900 })
    await makeDraft(PREMIUM, { amountPaise: 105000 })
    expect((await publish(PREMIUM)).status).toBe(409)
    expect((await toggle(PREMIUM, false)).status).toBe(409)
    expect((await fee(PREMIUM)).active!.amountPaise).toBe(99900)
  })

  it.each([
    ['five minutes ago', () => iso(-5 * 60_000)],
    ['more than a year ahead', () => iso(366 * DAY)],
    ['not a date', () => 'next friday'],
  ])('rejects an effective time %s (422)', async (_label, when) => {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    const res = await publish(PREMIUM, { effectiveFrom: when() })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0]).toEqual({ path: 'effectiveFrom', message: 'Pick a time from now up to one year ahead.' })
    expect((await fee(PREMIUM)).draft).not.toBeNull()
  })

  it('accepts a schedule up to a year out', async () => {
    expect((await schedule(PREMIUM, { amountPaise: 109900 }, 364)).status).toBe(200)
  })

  it('cancels a scheduled change, freeing the slot', async () => {
    const scheduled = (await schedule(PREMIUM, { amountPaise: 109900 })).body.data.scheduled as Version
    const res = await send('post', finance, `/payment-configs/versions/${scheduled.id}/cancel`, { reason: 'Decision reversed' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.changed.status).toBe('cancelled')
    expect(res.body.data.scheduled).toBeNull()
    expect(await actionsOf(scheduled.id)).toEqual(['scheduled', 'cancelled'])
    expect(await auditActions(scheduled.id)).toContain('payment_config.schedule_cancelled')
    expect((await schedule(PREMIUM, { amountPaise: 105000 })).status).toBe(200)
  })

  it('only cancels scheduled versions (409), needs a reason (422) and a real id (404)', async () => {
    const live = (await fee(PREMIUM)).active!
    const notScheduled = await send('post', finance, `/payment-configs/versions/${live.id}/cancel`, { reason: 'Try it' })
    expect(notScheduled.status).toBe(409)
    expect(notScheduled.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'Only scheduled changes can be cancelled.' })
    const scheduled = (await schedule(PREMIUM, { amountPaise: 109900 })).body.data.scheduled as Version
    expect((await send('post', finance, `/payment-configs/versions/${scheduled.id}/cancel`, {})).status).toBe(422)
    expect((await send('post', finance, `/payment-configs/versions/${randomUUID()}/cancel`, { reason: 'Because' })).status).toBe(404)
    expect((await send('post', finance, '/payment-configs/versions/not-a-uuid/cancel', { reason: 'Because' })).status).toBe(404)
  })

  it('the scheduler activates a due version, once, and retires the old one where the new begins', async () => {
    const scheduled = (await schedule(PREMIUM, { amountPaise: 109900 })).body.data.scheduled as Version
    const oldId = (await fee(PREMIUM)).active!.id
    expect(await activateDueVersions()).toBe(0) // not due yet

    const due = new Date(Date.now() - 2 * 60_000)
    await db.updateTable('payment_configurations').set({ effective_from: due }).where('id', '=', scheduled.id).execute()
    expect(await activateDueVersions()).toBe(1)
    expect(await activateDueVersions()).toBe(0) // idempotent

    const state = await fee(PREMIUM)
    expect(state.active).toMatchObject({ id: scheduled.id, status: 'active', amountPaise: 109900 })
    expect(state.scheduled).toBeNull()
    const old = state.versions.find((v) => v.id === oldId)!
    expect(old.status).toBe('superseded')
    expect(new Date(old.effectiveTo!).getTime()).toBe(due.getTime())
    expect(Number((await resolveFee(PREMIUM))!.amount_paise)).toBe(109900)
    expect((await pricing())[PREMIUM]!.amountPaise).toBe(109900) // the job purged the cache

    const history = await db.selectFrom('payment_configuration_history').select(['action', 'changed_by']).where('payment_configuration_id', '=', scheduled.id).orderBy('created_at').execute()
    expect(history).toEqual([{ action: 'scheduled', changed_by: finance.id }, { action: 'activated', changed_by: null }])
    const entry = await db.selectFrom('audit_logs').select(['actor_type', 'actor_id']).where('entity_id', '=', scheduled.id).where('action', '=', 'payment_config.activated').executeTakeFirstOrThrow()
    expect(entry).toEqual({ actor_type: 'system', actor_id: null })
  })

  it('a version cancelled before its time is never activated', async () => {
    const scheduled = (await schedule(PREMIUM, { amountPaise: 109900 })).body.data.scheduled as Version
    await send('post', finance, `/payment-configs/versions/${scheduled.id}/cancel`, { reason: 'Changed my mind' })
    await db.updateTable('payment_configurations').set({ effective_from: new Date(Date.now() - 60_000) }).where('id', '=', scheduled.id).execute()
    expect(await activateDueVersions()).toBe(0)
    expect((await fee(PREMIUM)).active!.amountPaise).toBe(99900)
  })
})

describe('switching a fee on and off', () => {
  it('switches a fee off as a new version, immediately, and tells the app', async () => {
    const before = (await fee(PREMIUM)).active!
    const res = await toggle(PREMIUM, false, 'Free listings during launch month')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.active).toMatchObject({ version: before.version + 1, isEnabled: false, amountPaise: before.amountPaise, changeReason: 'Free listings during launch month' })
    expect((await fee(PREMIUM)).versions.find((v) => v.id === before.id)!.status).toBe('superseded')
    expect((await pricing())[PREMIUM]).toEqual({ enabled: false })
    expect(await actionsOf(res.body.data.active.id)).toEqual(['disabled'])
    expect(await auditActions(res.body.data.active.id)).toContain('payment_config.toggled')
    expect(Number((await resolveFee(PREMIUM))!.is_enabled)).toBe(0)

    const on = await toggle(PREMIUM, true)
    expect(on.status).toBe(200)
    expect(on.body.data.active).toMatchObject({ isEnabled: true, version: before.version + 2 })
    expect(await actionsOf(on.body.data.active.id)).toEqual(['enabled'])
    expect((await pricing())[PREMIUM]).toMatchObject({ enabled: true, amountPaise: 99900 })
  })

  it('refuses to switch to the state it is already in (409)', async () => {
    const res = await toggle(PREMIUM, true)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'This fee is already on.' })
    expect((await toggle(CONTACT, false)).body.error.message).toBe('This fee is already off.')
  })

  it('needs a reason and a boolean (422)', async () => {
    for (const body of [{ enabled: false }, { enabled: false, reason: 'no' }, { reason: 'Because' }, { enabled: 'off', reason: 'Because' }]) {
      expect((await send('post', finance, `/payment-configs/${PREMIUM}/toggle`, body)).status, JSON.stringify(body)).toBe(422)
    }
    expect((await fee(PREMIUM)).active!.isEnabled).toBe(true)
  })

  it('keeps version numbers gap-free when a draft is waiting', async () => {
    const draft = await makeDraft(PREMIUM, { amountPaise: 109900 })
    expect(draft.version).toBe(2)
    const off = await toggle(PREMIUM, false)
    expect(off.body.data.active.version).toBe(2)
    expect((await fee(PREMIUM)).draft!.version).toBe(3)
    const live = await publish(PREMIUM, { confirmLargeChange: true })
    expect(live.status, JSON.stringify(live.body)).toBe(200)
    expect(live.body.data.active.version).toBe(3)
  })

  it('leaves a prepared draft alone', async () => {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await toggle(PREMIUM, false)
    expect((await fee(PREMIUM)).draft!.amountPaise).toBe(109900)
  })

  it('switching on a fee that is priced at ₹0 is refused (422)', async () => {
    await db.updateTable('payment_configurations').set({ amount_paise: 0, is_enabled: false }).where('fee_code', '=', PREMIUM).where('status', '=', 'active').execute()
    const res = await toggle(PREMIUM, true)
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('amountPaise')
  })
})

describe('restoring an old version', () => {
  it('publishes a copy of it as a new version, so history stays linear', async () => {
    const original = (await fee(PREMIUM)).active!
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await publish(PREMIUM)
    const res = await send('post', finance, `/payment-configs/versions/${original.id}/restore`, { reason: 'Price rise did not work' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.active).toMatchObject({ version: 3, amountPaise: 99900, status: 'active' })
    expect(res.body.data.active.id).not.toBe(original.id)
    const state = await fee(PREMIUM)
    expect(state.versions.map((v) => v.status)).toEqual(['active', 'superseded', 'superseded'])
    expect(await auditActions(res.body.data.active.id)).toContain('payment_config.restored')
    const entry = await db.selectFrom('audit_logs').selectAll().where('entity_id', '=', res.body.data.active.id).where('action', '=', 'payment_config.restored').executeTakeFirstOrThrow()
    expect(entry.new_values).toMatchObject({ restoredFromVersion: 1, version: 3 })
    expect((await pricing())[PREMIUM]!.amountPaise).toBe(99900)
  })

  it('can schedule a restore for later', async () => {
    const original = (await fee(PREMIUM)).active!
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await publish(PREMIUM)
    const res = await send('post', finance, `/payment-configs/versions/${original.id}/restore`, { reason: 'Back after the festival', effectiveFrom: iso(7 * DAY) })
    expect(res.status).toBe(200)
    expect(res.body.data.scheduled).toMatchObject({ status: 'scheduled', amountPaise: 99900 })
    expect(res.body.data.active.amountPaise).toBe(109900)
  })

  it('refuses the version that is already live (409), a draft (409) and a missing one (404)', async () => {
    const live = (await fee(PREMIUM)).active!
    const same = await send('post', finance, `/payment-configs/versions/${live.id}/restore`, { reason: 'Same again' })
    expect(same.status).toBe(409)
    expect(same.body.error.message).toBe('That is already the current version.')
    const draft = await makeDraft(PREMIUM, { amountPaise: 105000 })
    expect((await send('post', finance, `/payment-configs/versions/${draft.id}/restore`, { reason: 'A draft' })).status).toBe(409)
    expect((await send('post', finance, `/payment-configs/versions/${randomUUID()}/restore`, { reason: 'Nothing there' })).status).toBe(404)
    expect((await send('post', finance, `/payment-configs/versions/${live.id}/restore`, {})).status).toBe(422)
  })

  it('applies the large change guard and the schedule rules too', async () => {
    const original = (await fee(PREMIUM)).active!
    await makeDraft(PREMIUM, { amountPaise: 299000 })
    await publish(PREMIUM, { confirmLargeChange: true })
    const guarded = await send('post', finance, `/payment-configs/versions/${original.id}/restore`, { reason: 'Back down again' })
    expect(guarded.status).toBe(422)
    expect(guarded.body.error.message).toMatch(/% change\. Confirm it's intended\.$/)
    const confirmed = await send('post', finance, `/payment-configs/versions/${original.id}/restore`, { reason: 'Back down again', confirmLargeChange: true })
    expect(confirmed.status).toBe(200)
    const badTime = await send('post', finance, `/payment-configs/versions/${original.id}/restore`, { reason: 'Back down again', effectiveFrom: iso(400 * DAY) })
    expect(badTime.status).toBe(422)
  })
})

describe('change history', () => {
  async function seedHistory() {
    await makeDraft(PREMIUM, { amountPaise: 109900 })
    await publish(PREMIUM, { reason: 'First' })
    await toggle(PREMIUM, false, 'Second')
    await makeDraft(FEATURED, { amountPaise: 159900 })
    await publish(FEATURED, { reason: 'Third' })
  }

  it('lists changes across fees, newest first, with who and why', async () => {
    await seedHistory()
    const res = await get(finance, '/payment-configs/history?limit=100')
    expect(res.status).toBe(200)
    const mine = (res.body.data as { feeCode: string; reason: string | null; action: string; changedBy: { name: string } | null; version: number }[]).filter((h) => ['First', 'Second', 'Third'].includes(h.reason ?? ''))
    expect(mine.map((h) => h.reason)).toEqual(['Third', 'Second', 'First'])
    expect(mine[0]).toMatchObject({ feeCode: FEATURED, action: 'published', changedBy: { name: 'Farah Khan' } })
    expect(mine[1]).toMatchObject({ feeCode: PREMIUM, action: 'disabled', version: 3 })
    expect(res.body.meta).toMatchObject({ limit: 100 })
  })

  it('filters by fee, action, admin and date', async () => {
    await seedHistory()
    const byFee = (await get(finance, `/payment-configs/history?feeCode=${FEATURED}&limit=100`)).body.data as { feeCode: string }[]
    expect(byFee.length).toBeGreaterThan(0)
    expect(byFee.every((h) => h.feeCode === FEATURED)).toBe(true)
    const byAction = (await get(finance, '/payment-configs/history?action=disabled&limit=100')).body.data as { action: string }[]
    expect(byAction.every((h) => h.action === 'disabled')).toBe(true)
    const byAdmin = (await get(finance, `/payment-configs/history?adminId=${finance.id}&limit=100`)).body.data as { changedBy: { id: string } }[]
    expect(byAdmin.length).toBeGreaterThan(0)
    expect(byAdmin.every((h) => h.changedBy.id === finance.id)).toBe(true)
    expect(((await get(finance, `/payment-configs/history?adminId=${randomUUID()}`)).body.data as unknown[]).length).toBe(0)
    expect(((await get(finance, `/payment-configs/history?from=${encodeURIComponent(iso(DAY))}`)).body.data as unknown[]).length).toBe(0)
    expect(((await get(finance, `/payment-configs/history?from=${encodeURIComponent(iso(-DAY))}&to=${encodeURIComponent(iso(DAY))}`)).body.data as unknown[]).length).toBeGreaterThan(0)
  })

  it('pages with an opaque cursor until the end', async () => {
    await seedHistory()
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 100; i++) {
      const res: request.Response = await get(finance, `/payment-configs/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      expect(res.status).toBe(200)
      seen.push(...res.body.data.map((h: { id: string }) => h.id))
      cursor = res.body.meta.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    const total = Number((await db.selectFrom('payment_configuration_history').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n)
    expect(seen.length).toBe(total)
  })

  it('rejects a bad cursor, fee, action or limit (422)', async () => {
    for (const q of ['cursor=garbage', 'feeCode=NOPE', 'action=exploded', 'limit=500', 'adminId=x', 'from=yesterday']) {
      expect((await get(finance, `/payment-configs/history?${q}`)).status, q).toBe(422)
    }
  })
})

describe('GET /api/v1/app/pricing', () => {
  it('needs no sign-in and lists every fee with display data only', async () => {
    const res = await request(app).get(`${APP_API}/pricing`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=60')
    expect(Object.keys(res.body.data).sort()).toEqual([...FEE_CODES].sort())
    expect(res.body.data[PARENT_YEARLY]).toMatchObject({ enabled: true, amountPaise: 199900, billingPeriod: 'yearly', trialDays: 7, name: 'Parent membership · Yearly', versionId: expect.any(String) })
    expect(res.body.data[CONTACT]).toEqual({ enabled: false })
    expect(JSON.stringify(res.body.data)).not.toMatch(/published_by|change_reason|created_by/)
  })

  it('serves the version in force: a scheduled version only after it has been activated', async () => {
    await makeDraft(FEATURED, { amountPaise: 159900 })
    const res = await publish(FEATURED, { effectiveFrom: iso(2 * DAY) })
    expect((await pricing())[FEATURED]!.amountPaise).toBe(149900)
    await db.updateTable('payment_configurations').set({ effective_from: new Date(Date.now() - 1000) }).where('id', '=', res.body.data.scheduled.id).execute()
    await activateDueVersions()
    expect((await pricing())[FEATURED]!.amountPaise).toBe(159900)
  })
})
