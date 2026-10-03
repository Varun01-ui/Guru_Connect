import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { computeAmounts } from '../../../lib/money.js'
import { gateway, signCheckout } from '../../../lib/razorpay.js'
import { verhoeffCheckDigit } from '../../../lib/verhoeff.js'
import { APP, bearer, createParent, createStudent, createTeacher, loadMasters, purgeUsersByPhone, uploadFile } from '../../../test/appHelpers.js'
import type { Masters, TestParent, TestStudent, TestTeacher } from '../../../test/appHelpers.js'
import { cancelStaleOrders } from './payments.capture.js'

const app = createApp()
const phones: string[] = []
let m: Masters

const MONTHLY = 'PARENT_SUBSCRIPTION_MONTHLY'
const YEARLY = 'PARENT_SUBSCRIPTION_YEARLY'

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
async function newTeacher(over: Parameters<typeof createTeacher>[1] = {}): Promise<TestTeacher> {
  const t = await createTeacher(m, { status: 'draft', ...over })
  phones.push(t.phone)
  return t
}

const config = async (feeCode: string) => (await db.selectFrom('payment_configurations').selectAll().where('fee_code', '=', feeCode).where('status', '=', 'active').executeTakeFirstOrThrow())

type U = { token: string; userId: string }
const quote = (u: U, query: string) => request(app).get(`${APP}/payments/quote?${query}`).set(bearer(u))
const order = (u: U, body: object, key: string | null = randomUUID()) => {
  const r = request(app).post(`${APP}/payments/orders`).set(bearer(u))
  return (key ? r.set('Idempotency-Key', key) : r).send(body)
}
const verify = (u: U, body: object) => request(app).post(`${APP}/payments/verify`).set(bearer(u)).send(body)
const status = (u: U, id: string) => request(app).get(`${APP}/payments/${id}/status`).set(bearer(u))

async function orderBody(feeCode: string, over: Record<string, unknown> = {}) {
  const c = await config(feeCode)
  const amounts = computeAmounts({ amountPaise: Number(c.amount_paise), gstInclusive: c.gst_inclusive, gstRateBps: c.gst_rate_bps, walletBalancePaise: 0, maxRedeemPercent: 50 })
  return { feeCode, context: {}, useWallet: false, paymentConfigurationId: c.id, expectedPayablePaise: amounts.payablePaise, ...over }
}

async function placeOrder(u: U, feeCode = MONTHLY, over: Record<string, unknown> = {}) {
  const res = await order(u, await orderBody(feeCode, over))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as { transactionId: string; publicCode: string; checkout: { order_id: string; amount: number } }
}

// What Razorpay Checkout hands back after the customer pays.
async function pay(u: U, placed: { transactionId: string; checkout: { order_id: string } }, over: Parameters<typeof gateway.simulatePayment>[1] = {}) {
  const payment = gateway.simulatePayment(placed.checkout.order_id, over)
  const res = await verify(u, { transactionId: placed.transactionId, razorpayOrderId: payment.orderId, razorpayPaymentId: payment.id, razorpaySignature: signCheckout(payment.orderId, payment.id) })
  return { res, payment }
}

const subscriptionRow = (userId: string, type: 'parent' | 'student' | 'teacher') => db.selectFrom('subscriptions').selectAll().where('user_id', '=', userId).where('subscriber_type', '=', type).execute()

async function setWalletEnabled(enabled: boolean) {
  await db.deleteFrom('system_settings').where('key', '=', 'features.wallet_enabled').execute()
  if (enabled) {
    await db.insertInto('system_settings').values({ key: 'features.wallet_enabled', group_name: 'features', value: true as never, value_type: 'boolean', label: 'Wallet enabled', is_public: true } as never).execute()
  }
}
const credit = (userId: string, amount: number) => db.insertInto('wallet_ledger').values({ user_id: userId, amount_paise: amount, entry_type: 'admin_adjustment', description: 'Test credit', idempotency_key: `test:${randomUUID()}` }).execute()

beforeAll(async () => {
  m = await loadMasters()
  await setWalletEnabled(false)
})

afterEach(() => {
  gateway.reset()
})

afterAll(async () => {
  await setWalletEnabled(false)
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('computeAmounts (BR-43.3)', () => {
  const launch = { gstInclusive: true, gstRateBps: 1800, maxRedeemPercent: 50 }
  it.each([
    [29900, 0, 29900, 25339, 4561], // parent monthly
    [49900, 0, 49900, 42288, 7612], // teacher registration
    [4900, 0, 4900, 4153, 747], // contact unlock
    [29900, 10000, 19900, 16864, 3036], // parent monthly with Rs 100 wallet
    [199900, 10000, 189900, 160932, 28968], // parent yearly with Rs 100 wallet
  ])('%i with wallet %i pays %i = %i + %i GST', (amountPaise, wallet, payable, base, gst) => {
    const a = computeAmounts({ ...launch, amountPaise, walletBalancePaise: wallet })
    expect(a).toMatchObject({ listPaise: amountPaise, walletPaise: wallet, payablePaise: payable, basePaise: base, gstPaise: gst })
  })

  it('caps the wallet at the max redeem percent, ignores a non-positive balance and adds GST when exclusive', () => {
    expect(computeAmounts({ ...launch, amountPaise: 29900, walletBalancePaise: 1_000_000 }).walletPaise).toBe(14950)
    expect(computeAmounts({ ...launch, amountPaise: 29900, walletBalancePaise: -500 }).walletPaise).toBe(0)
    const ex = computeAmounts({ amountPaise: 10000, gstInclusive: false, gstRateBps: 1800, walletBalancePaise: 0, maxRedeemPercent: 50 })
    expect(ex).toMatchObject({ listPaise: 11800, payablePaise: 11800, basePaise: 10000, gstPaise: 1800 })
  })
})

describe('GET /payments/quote', () => {
  it('prices a parent plan with GST split and a period (BR-43.2)', async () => {
    const p = await newParent()
    const res = await quote(p, `feeCode=${MONTHLY}`)
    expect(res.status).toBe(200)
    const c = await config(MONTHLY)
    expect(res.body.data).toMatchObject({
      feeCode: MONTHLY,
      paymentConfigurationId: c.id,
      listAmountPaise: 29900,
      gstRateBps: 1800,
      gstInclusive: true,
      wallet: null,
      discountPaise: 0,
      payablePaise: 29900,
      basePaise: 25339,
      gstPaise: 4561,
      billingPeriod: 'monthly',
      validityDays: 30,
    })
    expect(res.body.data.period.queued).toBe(false)
  })

  it('refuses unknown, unsupported and role-mismatched fee codes', async () => {
    const p = await newParent()
    expect((await quote(p, 'feeCode=NOPE')).status).toBe(422)
    expect((await quote(p, 'feeCode=CONTACT_UNLOCK')).status).toBe(422)
    expect((await quote(p, '')).status).toBe(422)
    const wrongRole = await quote(p, 'feeCode=TEACHER_REGISTRATION')
    expect(wrongRole.status).toBe(403)
    expect(wrongRole.body.error.code).toBe('FORBIDDEN')
    expect((await quote(p, `feeCode=${MONTHLY}&leadId=${randomUUID()}`)).status).toBe(422)
    expect((await quote(p, `feeCode=${MONTHLY}&renewal=true`)).status).toBe(422)
    expect((await request(app).get(`${APP}/payments/quote?feeCode=${MONTHLY}`)).status).toBe(401)
  })

  it('reports a switched-off fee as fee_disabled', async () => {
    const p = await newParent()
    await db.updateTable('payment_configurations').set({ is_enabled: false }).where('fee_code', '=', MONTHLY).where('status', '=', 'active').execute()
    try {
      const res = await quote(p, `feeCode=${MONTHLY}`)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'fee_disabled' } })
    } finally {
      await db.updateTable('payment_configurations').set({ is_enabled: true }).where('fee_code', '=', MONTHLY).where('status', '=', 'active').execute()
    }
  })

  it('applies the subscription purchase rules (BR-43.9)', async () => {
    const day = 86_400_000
    const mk = (userId: string, over: Record<string, unknown>) =>
      db.insertInto('subscriptions').values({ user_id: userId, subscriber_type: 'parent', fee_code: MONTHLY, starts_at: new Date(Date.now() - 5 * day), ...over } as never).execute()

    const trial = await newParent()
    await mk(trial.userId, { status: 'trial', trial_ends_at: new Date(Date.now() + 2 * day), ends_at: new Date(Date.now() + 2 * day) })
    expect((await quote(trial, `feeCode=${MONTHLY}`)).body.data.period.queued).toBe(false)

    const soon = await newParent()
    const soonEnds = new Date(Date.now() + 10 * day)
    await mk(soon.userId, { status: 'active', ends_at: soonEnds })
    const queued = await quote(soon, `feeCode=${MONTHLY}`)
    expect(queued.body.data.period).toMatchObject({ queued: true, startsAt: soonEnds.toISOString() })

    const far = await newParent()
    await mk(far.userId, { status: 'active', ends_at: new Date(Date.now() + 45 * day) })
    const already = await quote(far, `feeCode=${YEARLY}`)
    expect(already.status).toBe(409)
    expect(already.body.error.details.reason).toBe('already_subscribed')

    const free = await newParent()
    await mk(free.userId, { status: 'free_access', ends_at: null })
    expect((await quote(free, `feeCode=${MONTHLY}`)).body.error.details.reason).toBe('free_access')
  })

  it('shows and caps the wallet only when the wallet is on and has a balance (BR-43.4)', async () => {
    const p = await newParent()
    await credit(p.userId, 10000)
    expect((await quote(p, `feeCode=${MONTHLY}&useWallet=true`)).body.data.wallet).toBeNull() // wallet feature off

    await setWalletEnabled(true)
    try {
      const res = await quote(p, `feeCode=${MONTHLY}&useWallet=true`)
      expect(res.body.data.wallet).toEqual({ balancePaise: 10000, maxRedeemPercent: 50, maxRedeemPaise: 14950, appliedPaise: 10000 })
      expect(res.body.data).toMatchObject({ discountPaise: 10000, payablePaise: 19900, basePaise: 16864, gstPaise: 3036 })
      const without = await quote(p, `feeCode=${MONTHLY}`)
      expect(without.body.data).toMatchObject({ discountPaise: 0, payablePaise: 29900 })
      expect(without.body.data.wallet.appliedPaise).toBe(0)

      const empty = await newParent()
      expect((await quote(empty, `feeCode=${MONTHLY}&useWallet=true`)).body.data.wallet).toBeNull()
    } finally {
      await setWalletEnabled(false)
    }
  })

  it('blocks students who are covered by a parent plan or still waiting for consent', async () => {
    const parent = await newParent()
    await db.insertInto('subscriptions').values({ user_id: parent.userId, subscriber_type: 'parent', fee_code: YEARLY, status: 'active', starts_at: new Date(Date.now() - 1000), ends_at: new Date(Date.now() + 200 * 86_400_000) }).execute()
    const covered = await newStudent({ parentId: parent.parentId, parentLinkStatus: 'confirmed' })
    const res = await quote(covered, 'feeCode=STUDENT_SUBSCRIPTION_MONTHLY')
    expect(res.status).toBe(409)
    expect(res.body.error.details.reason).toBe('covered_by_parent')

    const pending = await newStudent({ parentalConsent: 'pending' })
    const blocked = await quote(pending, 'feeCode=STUDENT_SUBSCRIPTION_MONTHLY')
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.details.reason).toBe('parental_consent_pending')

    const free = await newStudent({ parentalConsent: 'confirmed' })
    expect((await quote(free, 'feeCode=STUDENT_SUBSCRIPTION_YEARLY')).body.data.payablePaise).toBe(149900)
  })

  it('quotes the teacher registration fee only to drafts that have not paid', async () => {
    const draft = await newTeacher()
    const res = await quote(draft, 'feeCode=TEACHER_REGISTRATION')
    expect(res.body.data).toMatchObject({ payablePaise: 49900, basePaise: 42288, gstPaise: 7612, period: null })

    const approved = await newTeacher({ status: 'approved' })
    const no = await quote(approved, 'feeCode=TEACHER_REGISTRATION')
    expect(no.status).toBe(409)
    expect(no.body.error.details.reason).toBe('not_payable')
    expect((await quote(approved, 'feeCode=TEACHER_REGISTRATION&renewal=true')).status).toBe(200)

    const paid = await newTeacher()
    const txn = await db.insertInto('transactions').values({ user_id: paid.userId, payer_type: 'teacher', purpose: 'teacher_registration', amount_paise: 1, base_amount_paise: 1, status: 'captured' }).returning('id').executeTakeFirstOrThrow()
    await db.updateTable('teachers').set({ registration_transaction_id: txn.id }).where('id', '=', paid.teacherId).execute()
    expect((await quote(paid, 'feeCode=TEACHER_REGISTRATION')).body.error.details.reason).toBe('already_paid')
  })
})

describe('POST /payments/orders', () => {
  it('creates the transaction and checkout options (BR-43.5, BR-43.6)', async () => {
    const p = await newParent()
    const res = await order(p, await orderBody(MONTHLY))
    expect(res.status).toBe(201)
    const d = res.body.data
    expect(d.status).toBe('created')
    expect(d.publicCode).toMatch(/^TXN-/)
    expect(new Date(d.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(d.checkout).toMatchObject({
      order_id: expect.stringMatching(/^order_[A-Za-z0-9]{14}$/),
      amount: 29900,
      currency: 'INR',
      name: 'GuruConnect',
      description: expect.any(String),
      prefill: { contact: p.phone },
      readonly: { contact: true },
      theme: { color: '#1B7F5A' },
      method: { upi: true, card: true, netbanking: true, wallet: false, emi: false, paylater: false },
      retry: { enabled: true, max_count: 3 },
      timeout: 900,
      send_sms_hash: true,
      notes: { transactionId: d.transactionId, feeCode: MONTHLY },
    })
    expect(JSON.stringify(d)).not.toContain('secret')

    const row = await db.selectFrom('transactions').selectAll().where('id', '=', d.transactionId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ status: 'created', payer_type: 'parent', purpose: 'subscription', fee_code: MONTHLY, gateway: 'razorpay', gateway_order_id: d.checkout.order_id, direction: 'credit' })
    expect(Number(row.amount_paise) + 0).toBe(29900)
    expect(Number(row.base_amount_paise)).toBe(25339)
    expect(Number(row.gst_paise)).toBe(4561)
    expect(row.metadata).toMatchObject({ listAmountPaise: 29900, walletRedeemedPaise: 0 })
    const audit = await db.selectFrom('audit_logs').select('module').where('actor_id', '=', p.userId).where('action', '=', 'app.payment_started').executeTakeFirst()
    expect(audit?.module).toBe('app.payments')
  })

  it('needs a v4 Idempotency-Key and a valid body', async () => {
    const p = await newParent()
    const body = await orderBody(MONTHLY)
    expect((await order(p, body, null)).status).toBe(422)
    expect((await order(p, body, 'not-a-uuid')).status).toBe(422)
    expect((await order(p, { ...body, expectedPayablePaise: 50 })).status).toBe(422)
    expect((await order(p, { ...body, paymentConfigurationId: 'x' })).status).toBe(422)
    expect((await order(p, { ...body, feeCode: 'NOPE' })).status).toBe(422)
    expect((await request(app).post(`${APP}/payments/orders`).set('Idempotency-Key', randomUUID()).send(body)).status).toBe(401)
  })

  it('replays the same response for the same key and body, and rejects the key with another body', async () => {
    const p = await newParent()
    const key = randomUUID()
    const body = await orderBody(MONTHLY)
    const a = await order(p, body, key)
    const b = await order(p, body, key)
    expect(b.status).toBe(201)
    expect(b.body.data).toEqual(a.body.data)
    const other = await order(p, await orderBody(YEARLY), key)
    expect(other.status).toBe(422)
    expect(other.body.error.details[0].reason).toBe('idempotency_key_reused')
  })

  it('reuses an open order for the same fee instead of creating another (BR-43.5 step 2)', async () => {
    const p = await newParent()
    const first = await placeOrder(p)
    const second = await placeOrder(p)
    expect(second.transactionId).toBe(first.transactionId)
    expect(second.checkout.order_id).toBe(first.checkout.order_id)
    expect(gateway.orders.size).toBe(1)
    expect(await db.selectFrom('transactions').select('id').where('user_id', '=', p.userId).execute()).toHaveLength(1)
  })

  it('answers payment_in_progress while an authorized payment exists', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    await pay(p, placed, { status: 'authorized' })
    const again = await order(p, await orderBody(MONTHLY))
    expect(again.status).toBe(409)
    expect(again.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'payment_in_progress', transactionId: placed.transactionId } })
  })

  it('refuses a stale price version or amount with the fresh quote (BR-43.2)', async () => {
    const p = await newParent()
    const stale = await order(p, await orderBody(MONTHLY, { paymentConfigurationId: randomUUID() }))
    expect(stale.status).toBe(409)
    expect(stale.body.error.details.reason).toBe('price_changed')
    expect(stale.body.error.details.quote).toMatchObject({ feeCode: MONTHLY, payablePaise: 29900 })
    const wrongAmount = await order(p, await orderBody(MONTHLY, { expectedPayablePaise: 19900 }))
    expect(wrongAmount.body.error.details.reason).toBe('price_changed')
    expect(await db.selectFrom('transactions').select('id').where('user_id', '=', p.userId).execute()).toHaveLength(0)
  })

  it('enforces role and purchase preconditions', async () => {
    const t = await newTeacher()
    const wrongRole = await order(t, await orderBody(MONTHLY))
    expect(wrongRole.status).toBe(403)
    const pending = await newStudent({ parentalConsent: 'pending' })
    expect((await order(pending, await orderBody('STUDENT_SUBSCRIPTION_MONTHLY'))).status).toBe(403)
    const live = await newParent()
    await db.insertInto('subscriptions').values({ user_id: live.userId, subscriber_type: 'parent', fee_code: MONTHLY, status: 'active', starts_at: new Date(Date.now() - 1000), ends_at: new Date(Date.now() + 90 * 86_400_000) }).execute()
    expect((await order(live, await orderBody(MONTHLY))).body.error.details.reason).toBe('already_subscribed')
  })

  it('maps a gateway outage to GATEWAY_ERROR and leaves no order or wallet debit (BR-43.5 step 5)', async () => {
    const p = await newParent()
    await setWalletEnabled(true)
    try {
      await credit(p.userId, 10000)
      gateway.failNextOrder = true
      const res = await order(p, await orderBody(MONTHLY, { useWallet: true, expectedPayablePaise: 19900 }))
      expect(res.status).toBe(502)
      expect(res.body.error.code).toBe('GATEWAY_ERROR')
      expect(await db.selectFrom('transactions').select('id').where('user_id', '=', p.userId).execute()).toHaveLength(0)
      const ledger = await db.selectFrom('wallet_ledger').select('amount_paise').where('user_id', '=', p.userId).execute()
      expect(ledger.map((l) => Number(l.amount_paise))).toEqual([10000])
    } finally {
      await setWalletEnabled(false)
    }
  })

  it('debits the wallet at checkout and gives it back when the order expires (BR-43.5, BR-43.11)', async () => {
    const p = await newParent()
    await setWalletEnabled(true)
    try {
      await credit(p.userId, 10000)
      const placed = await placeOrder(p, MONTHLY, { useWallet: true, expectedPayablePaise: 19900 })
      expect(placed.checkout.amount).toBe(19900)
      const row = await db.selectFrom('transactions').select(['amount_paise', 'discount_paise', 'base_amount_paise', 'gst_paise', 'metadata']).where('id', '=', placed.transactionId).executeTakeFirstOrThrow()
      expect([Number(row.amount_paise), Number(row.discount_paise), Number(row.base_amount_paise), Number(row.gst_paise)]).toEqual([19900, 10000, 16864, 3036])
      expect(row.metadata).toMatchObject({ listAmountPaise: 29900, walletRedeemedPaise: 10000 })
      const debit = await db.selectFrom('wallet_ledger').select(['amount_paise', 'entry_type']).where('idempotency_key', '=', `redeem:${placed.transactionId}`).executeTakeFirstOrThrow()
      expect([Number(debit.amount_paise), debit.entry_type]).toEqual([-10000, 'checkout_redemption'])

      // two devices cannot spend the same balance
      const second = await order(p, await orderBody(MONTHLY, { useWallet: true, expectedPayablePaise: 29900 }))
      expect(second.status).toBe(201)
      expect(second.body.data.checkout.amount).toBe(29900)

      await db.updateTable('transactions').set({ created_at: new Date(Date.now() - 31 * 60_000) }).where('id', '=', placed.transactionId).execute()
      expect(await cancelStaleOrders()).toBeGreaterThanOrEqual(1)
      expect(await cancelStaleOrders()).toBe(0)
      const refund = await db.selectFrom('wallet_ledger').select('amount_paise').where('idempotency_key', '=', `redeem_refund:${placed.transactionId}`).executeTakeFirstOrThrow()
      expect(Number(refund.amount_paise)).toBe(10000)
      expect((await status(p, placed.transactionId)).body.data.status).toBe('expired')
    } finally {
      await setWalletEnabled(false)
    }
  })

  it('allows at most 3 open orders per user (BR-43.13)', async () => {
    const p = await newParent()
    for (let i = 0; i < 3; i++) {
      await db.insertInto('transactions').values({ user_id: p.userId, payer_type: 'parent', purpose: 'premium_listing', fee_code: 'PREMIUM_TEACHER', amount_paise: 100, base_amount_paise: 85, status: 'created' }).execute()
    }
    const res = await order(p, await orderBody(MONTHLY))
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
  })

  it('rate limits order creation to 10 a minute', async () => {
    const p = await newParent()
    let last = 0
    for (let i = 0; i < 11; i++) last = (await order(p, await orderBody(MONTHLY, { expectedPayablePaise: 100 + i }))).status
    expect(last).toBe(429)
  })
})

describe('POST /payments/verify and fulfilment (BR-43.8, BR-43.11)', () => {
  it('captures a verified payment and starts the subscription exactly once', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    const { res, payment } = await pay(p, placed)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ transactionId: placed.transactionId, status: 'success', fulfilment: { type: 'subscription', state: 'done' } })

    const [sub, ...rest] = await subscriptionRow(p.userId, 'parent')
    expect(rest).toHaveLength(0)
    expect(sub).toMatchObject({ status: 'active', fee_code: MONTHLY, last_transaction_id: placed.transactionId, auto_renew: false })
    expect(Number(sub!.price_paise)).toBe(29900)
    expect(sub!.ends_at!.getTime() - sub!.starts_at.getTime()).toBe(30 * 86_400_000)
    expect(res.body.data.fulfilment.subscriptionId).toBe(sub!.id)

    const txn = await db.selectFrom('transactions').selectAll().where('id', '=', placed.transactionId).executeTakeFirstOrThrow()
    expect(txn).toMatchObject({ status: 'captured', gateway_payment_id: payment.id, method: 'upi' })
    expect(txn.captured_at).not.toBeNull()
    const meta = txn.metadata as { payerFingerprint?: string }
    expect(meta.payerFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(txn)).not.toContain('okbank') // the raw instrument is never stored
    const note = await db.selectFrom('user_notifications').select('event_type').where('user_id', '=', p.userId).execute()
    expect(note.map((n) => n.event_type)).toEqual(['payment.captured'])

    // verifying again (client retry / webhook) changes nothing
    const again = await verify(p, { transactionId: placed.transactionId, razorpayOrderId: payment.orderId, razorpayPaymentId: payment.id, razorpaySignature: signCheckout(payment.orderId, payment.id) })
    expect(again.body.data.status).toBe('success')
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(1)
    expect(await db.selectFrom('user_notifications').select('id').where('user_id', '=', p.userId).execute()).toHaveLength(1)
  })

  it('ends a trial and starts the paid period immediately (T10.1, T13.6)', async () => {
    const s = await newStudent({ parentalConsent: 'confirmed' })
    const trial = await db
      .insertInto('subscriptions')
      .values({ user_id: s.userId, subscriber_type: 'student', fee_code: 'STUDENT_SUBSCRIPTION_MONTHLY', status: 'trial', starts_at: new Date(Date.now() - 86_400_000), trial_ends_at: new Date(Date.now() + 86_400_000), ends_at: new Date(Date.now() + 86_400_000) })
      .returning('id')
      .executeTakeFirstOrThrow()
    const placed = await placeOrder(s, 'STUDENT_SUBSCRIPTION_YEARLY')
    expect((await pay(s, placed)).res.body.data.status).toBe('success')
    const rows = await subscriptionRow(s.userId, 'student')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: trial.id, status: 'active', fee_code: 'STUDENT_SUBSCRIPTION_YEARLY' })
    expect(rows[0]!.ends_at!.getTime() - Date.now()).toBeGreaterThan(364 * 86_400_000)
  })

  it('queues the next period behind a soon-ending plan without creating a second live row', async () => {
    const p = await newParent()
    const ends = new Date(Date.now() + 10 * 86_400_000)
    const live = await db.insertInto('subscriptions').values({ user_id: p.userId, subscriber_type: 'parent', fee_code: MONTHLY, status: 'active', starts_at: new Date(Date.now() - 20 * 86_400_000), ends_at: ends }).returning('id').executeTakeFirstOrThrow()
    const placed = await placeOrder(p)
    const { res } = await pay(p, placed)
    expect(res.body.data.fulfilment).toMatchObject({ state: 'done', queued: true, subscriptionId: live.id })
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(1)
    const txn = await db.selectFrom('transactions').select('metadata').where('id', '=', placed.transactionId).executeTakeFirstOrThrow()
    expect((txn.metadata as { pendingPeriod: { startsAt: string } }).pendingPeriod.startsAt).toBe(ends.toISOString())
  })

  it('flags a capture that is no longer a valid purchase for a refund instead of granting twice', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    await db.insertInto('subscriptions').values({ user_id: p.userId, subscriber_type: 'parent', fee_code: YEARLY, status: 'active', starts_at: new Date(), ends_at: new Date(Date.now() + 300 * 86_400_000) }).execute()
    const { res } = await pay(p, placed)
    expect(res.body.data.fulfilment.state).toBe('refund_pending')
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(1)
    const txn = await db.selectFrom('transactions').select('metadata').where('id', '=', placed.transactionId).executeTakeFirstOrThrow()
    expect(txn.metadata).toMatchObject({ refundRequest: 'duplicate_charge' })
  })

  it('records the teacher registration payment on the teacher and lets M15 submit with it', async () => {
    const t = await newTeacher()
    const placed = await placeOrder(t, 'TEACHER_REGISTRATION')
    expect(placed.checkout.amount).toBe(49900)
    const { res } = await pay(t, placed)
    expect(res.body.data).toMatchObject({ status: 'success', fulfilment: { type: 'teacher_registration', state: 'done' } })
    const row = await db.selectFrom('teachers').select('registration_transaction_id').where('id', '=', t.teacherId).executeTakeFirstOrThrow()
    expect(row.registration_transaction_id).toBe(placed.transactionId)
    expect((await quote(t, 'feeCode=TEACHER_REGISTRATION')).body.error.details.reason).toBe('already_paid')

    // end to end with M15: required documents, then submit with this transaction
    const aadhaar = `49123456789${verhoeffCheckDigit('49123456789')}`
    const add = async (docType: string, extra: object, mime: 'image/jpeg' | 'application/pdf' = 'image/jpeg') => {
      const { fileId } = await uploadFile(app, t, { purpose: 'teacher_document', mimeType: mime })
      return request(app).post(`${APP}/teacher/documents`).set(bearer(t)).send({ docType, fileId, ...extra })
    }
    expect((await add('aadhaar', { docNumber: aadhaar })).status).toBe(201)
    expect((await add('pan', { docNumber: 'ABCDE1234F' })).status).toBe(201)
    expect((await add('education_certificate', { title: 'B.Ed. 2010' }, 'application/pdf')).status).toBe(201)
    expect((await add('photo', {})).status).toBe(201)
    const submit = await request(app).post(`${APP}/teacher/registration/submit`).set(bearer(t)).send({ transactionId: placed.transactionId })
    expect(submit.status).toBe(200)
    expect(submit.body.data.verificationStatus).toBe('pending')
  })

  it('rejects a bad signature, a wrong order id and someone else\'s transaction (BR-43.8)', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    const payment = gateway.simulatePayment(placed.checkout.order_id)
    const good = { transactionId: placed.transactionId, razorpayOrderId: payment.orderId, razorpayPaymentId: payment.id, razorpaySignature: signCheckout(payment.orderId, payment.id) }

    const forged = await verify(p, { ...good, razorpaySignature: 'a'.repeat(64) })
    expect(forged.status).toBe(402)
    expect(forged.body.error).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'signature_mismatch' } })
    const wrongOrder = await verify(p, { ...good, razorpayOrderId: 'order_AAAAAAAAAAAAAA', razorpaySignature: signCheckout('order_AAAAAAAAAAAAAA', payment.id) })
    expect(wrongOrder.status).toBe(402)
    const row = await db.selectFrom('transactions').select(['status', 'gateway_payment_id']).where('id', '=', placed.transactionId).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'created', gateway_payment_id: null })
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(0)
    const audit = await db.selectFrom('audit_logs').select('id').where('actor_id', '=', p.userId).where('action', '=', 'app.payment_signature_mismatch').execute()
    expect(audit).toHaveLength(2)

    const stranger = await newParent()
    const theirs = await verify(stranger, good)
    expect(theirs.status).toBe(404)
    expect(theirs.body.error.code).toBe('NOT_FOUND')
  })

  it('validates the id and signature formats', async () => {
    const p = await newParent()
    const base = { transactionId: randomUUID(), razorpayOrderId: 'order_AAAAAAAAAAAAAA', razorpayPaymentId: 'pay_AAAAAAAAAAAAAA', razorpaySignature: 'a'.repeat(64) }
    for (const over of [{ transactionId: 'x' }, { razorpayOrderId: 'order_short' }, { razorpayPaymentId: 'pay_' }, { razorpaySignature: 'zz' }]) {
      expect((await verify(p, { ...base, ...over })).status).toBe(422)
    }
    expect((await verify(p, base)).status).toBe(404)
  })

  it('reports processing while the bank is still confirming, and failure when the gateway declines', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    const { res } = await pay(p, placed, { status: 'authorized' })
    expect(res.body.data).toMatchObject({ status: 'processing', nextPollAfterMs: 2000 })
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(0)
    expect((await status(p, placed.transactionId)).body.data).toMatchObject({ status: 'processing', rawStatus: 'authorized' })

    const q = await newParent()
    const second = await placeOrder(q)
    const failed = await pay(q, second, { status: 'failed', errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'Payment was declined by the bank.' })
    expect(failed.res.body.data.status).toBe('failed')
    const st = await status(q, second.transactionId)
    expect(st.body.data).toMatchObject({ status: 'failed', failure: { code: 'BAD_REQUEST_ERROR', reason: 'Payment was declined by the bank.' }, canRetry: true, nextPollAfterMs: null })
    expect((await db.selectFrom('user_notifications').select('event_type').where('user_id', '=', q.userId).execute()).map((n) => n.event_type)).toEqual(['payment.failed'])
  })

  it('lets a later capture on the same order move failed to captured (BR-43.10)', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    await pay(p, placed, { status: 'failed', errorCode: 'X', errorDescription: 'declined' })
    const retry = await pay(p, placed, { status: 'captured' })
    expect(retry.res.body.data.status).toBe('success')
    expect((await subscriptionRow(p.userId, 'parent'))).toHaveLength(1)
  })

  it('rate limits verification to 20 a minute', async () => {
    const p = await newParent()
    const body = { transactionId: randomUUID(), razorpayOrderId: 'order_AAAAAAAAAAAAAA', razorpayPaymentId: 'pay_AAAAAAAAAAAAAA', razorpaySignature: 'a'.repeat(64) }
    let last = 0
    for (let i = 0; i < 21; i++) last = (await verify(p, body)).status
    expect(last).toBe(429)
  })
})

describe('GET /payments/:id/status (BR-43.10)', () => {
  it('shows pending for a fresh order and 404s for someone else\'s', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    const res = await status(p, placed.transactionId)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ transactionId: placed.transactionId, publicCode: placed.publicCode, status: 'pending', rawStatus: 'created', amountPaise: 29900, fulfilment: null, invoiceAvailable: false, canRetry: false, nextPollAfterMs: 2000 })
    const stranger = await newParent()
    expect((await status(stranger, placed.transactionId)).status).toBe(404)
    expect((await status(p, 'nope')).status).toBe(422)
    expect((await request(app).get(`${APP}/payments/${placed.transactionId}/status`)).status).toBe(401)
  })

  it('syncs from the gateway when the app never called verify (UPI app in front, app killed)', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    gateway.simulatePayment(placed.checkout.order_id, { status: 'captured' })
    // too early: the server waits 20 s before asking the gateway
    expect((await status(p, placed.transactionId)).body.data.status).toBe('pending')
    await db.updateTable('transactions').set({ created_at: new Date(Date.now() - 25_000) }).where('id', '=', placed.transactionId).execute()
    const res = await status(p, placed.transactionId)
    expect(res.body.data).toMatchObject({ status: 'success', rawStatus: 'captured', method: 'upi', fulfilment: { type: 'subscription', state: 'done' } })
    expect(await subscriptionRow(p.userId, 'parent')).toHaveLength(1)
  })

  it('syncs a gateway failure and throttles gateway lookups to one per 10 seconds', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    await db.updateTable('transactions').set({ created_at: new Date(Date.now() - 25_000) }).where('id', '=', placed.transactionId).execute()
    expect((await status(p, placed.transactionId)).body.data.status).toBe('pending') // gateway has nothing yet
    gateway.simulatePayment(placed.checkout.order_id, { status: 'failed', errorCode: 'E', errorDescription: 'nope' })
    expect((await status(p, placed.transactionId)).body.data.status).toBe('pending') // within 10 s: not asked again
  })

  it('rate limits polling to 60 a minute', async () => {
    const p = await newParent()
    const placed = await placeOrder(p)
    let last = 0
    for (let i = 0; i < 61; i++) last = (await status(p, placed.transactionId)).status
    expect(last).toBe(429)
  })
})
