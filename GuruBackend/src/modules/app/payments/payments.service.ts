import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import type { z } from 'zod'
import { env } from '../../../config/env.js'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { conflictState, gatewayError, notFound, paymentFailed, rateLimited, validationFailed } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { gateway, signatureMatches } from '../../../lib/razorpay.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import type { RequestContext } from '../student/student.service.js'
import { applyCapture, applyFailure } from './payments.capture.js'
import type { Fulfilment } from './payments.capture.js'
import { buildQuote, presentQuote } from './payments.pricing.js'
import type { Payer } from './payments.pricing.js'
import type { createOrderSchema, verifyPaymentSchema } from './payments.schemas.js'

const ORDER_REUSE_MINUTES = 25
const ORDER_EXPIRY_MINUTES = 30
const MAX_OPEN_ORDERS = 3
const GATEWAY_TIMEOUT_MS = 8000

type CreateOrderBody = z.infer<typeof createOrderSchema>
type VerifyBody = z.infer<typeof verifyPaymentSchema>

async function limit(key: string, max: number, windowMs: number) {
  const r = await hitRateLimit(key, max, windowMs)
  if (!r.allowed) throw rateLimited(r.retryAfterSeconds)
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('gateway timeout')), ms))])

// ---- GET /payments/quote ----

export async function getQuote(payer: Payer, query: { feeCode: string; useWallet: boolean; leadId?: string; renewal?: boolean }) {
  const quote = await buildQuote(payer, { feeCode: query.feeCode, useWallet: query.useWallet, context: { leadId: query.leadId, renewal: query.renewal } })
  return presentQuote(quote)
}

// ---- POST /payments/orders (BR-43.5) ----

type OpenTxn = { id: string; fee_code: string | null; public_code: string; status: string; gateway_order_id: string | null; payment_configuration_id: string | null; amount_paise: number | string; created_at: Date; metadata: Record<string, unknown> }

async function checkoutOptions(payer: Payer, txn: { id: string; gateway_order_id: string; amount_paise: number | string; fee_code: string | null }, description: string) {
  const user = await db.selectFrom('app_users').select(['full_name', 'phone', 'email']).where('id', '=', payer.userId).executeTakeFirstOrThrow()
  return {
    key: gateway.keyId,
    order_id: txn.gateway_order_id,
    amount: Number(txn.amount_paise),
    currency: 'INR',
    name: 'GuruConnect',
    description,
    image: `${env.CDN_BASE_URL}/brand/logo-192.png`,
    prefill: { name: user.full_name, contact: user.phone, email: user.email },
    readonly: { contact: true },
    theme: { color: '#1B7F5A' },
    method: { upi: true, card: true, netbanking: true, wallet: false, emi: false, paylater: false },
    config: { display: { blocks: { upi: { name: 'Pay using UPI', instruments: [{ method: 'upi' }] } }, sequence: ['block.upi'], preferences: { show_default_blocks: true } } },
    retry: { enabled: true, max_count: 3 },
    timeout: 900,
    send_sms_hash: true,
    notes: { transactionId: txn.id, feeCode: txn.fee_code },
  }
}

const sameContext = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

export async function createOrder(payer: Payer, body: CreateOrderBody, idempotencyKey: string, ctx: RequestContext & { platform: string | null; appVersion: string | null }) {
  const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const idemKey = `app:${payer.userId}:${idempotencyKey}`
  const stored = await getIdempotent(idemKey)
  if (stored) {
    const { bodyHash: storedHash, response } = stored.body as { bodyHash: string; response: unknown }
    if (storedHash !== bodyHash) throw validationFailed([{ path: 'Idempotency-Key', message: 'Please try again.', reason: 'idempotency_key_reused' }], 'Please try again.')
    return response
  }

  await limit(`pay-order-min:${payer.userId}`, 10, 60_000)
  await limit(`pay-order-hour:${payer.userId}`, 30, 3_600_000)

  const context = { leadId: body.context.leadId ?? undefined, renewal: body.context.renewal ?? undefined }
  const response = await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`pay:${payer.userId}:${body.feeCode}`}))`.execute(trx)
    // Wallet debits are serialised per user so two devices cannot spend the same balance (re-read under this lock).
    if (body.useWallet) await sql`select pg_advisory_xact_lock(hashtext(${`wallet:${payer.userId}`}))`.execute(trx)

    const quote = await buildQuote(payer, { feeCode: body.feeCode, useWallet: body.useWallet, context }, trx)
    if (quote.config.id !== body.paymentConfigurationId || quote.amounts.payablePaise !== body.expectedPayablePaise) {
      throw conflictState('The price was updated. Please review.', { reason: 'price_changed', quote: presentQuote(quote) })
    }

    const since = new Date(Date.now() - ORDER_EXPIRY_MINUTES * 60_000)
    const open = (await trx
      .selectFrom('transactions')
      .select(['id', 'fee_code', 'public_code', 'status', 'gateway_order_id', 'payment_configuration_id', 'amount_paise', 'created_at', 'metadata'])
      .where('user_id', '=', payer.userId)
      .where('status', 'in', ['created', 'authorized'])
      .where('created_at', '>', since)
      .execute()) as OpenTxn[]
    const sameKey = open.filter((o) => o.fee_code === quote.feeCode && sameContext(o.metadata.context, quote.context))

    const inProgress = sameKey.find((o) => o.status === 'authorized')
    if (inProgress) throw conflictState('A payment is already being processed.', { reason: 'payment_in_progress', transactionId: inProgress.id })

    const reusable = sameKey.find(
      (o) => o.status === 'created' && o.payment_configuration_id === quote.config.id && Number(o.metadata.walletRedeemedPaise ?? 0) === quote.amounts.walletPaise && o.created_at.getTime() > Date.now() - ORDER_REUSE_MINUTES * 60_000 && o.gateway_order_id,
    )
    if (reusable) {
      return {
        transactionId: reusable.id,
        publicCode: reusable.public_code,
        status: 'created' as const,
        expiresAt: new Date(reusable.created_at.getTime() + ORDER_EXPIRY_MINUTES * 60_000).toISOString(),
        checkout: await checkoutOptions(payer, { id: reusable.id, gateway_order_id: reusable.gateway_order_id!, amount_paise: reusable.amount_paise, fee_code: quote.feeCode }, quote.config.name),
      }
    }

    if (open.filter((o) => o.status === 'created').length >= MAX_OPEN_ORDERS) throw rateLimited(60, 'You have too many unfinished payments. Finish one or wait a few minutes.')

    const { amounts } = quote
    const txn = await trx
      .insertInto('transactions')
      .values({
        user_id: payer.userId,
        payer_type: quote.rule.payerType,
        purpose: quote.rule.purpose,
        direction: 'credit',
        payment_configuration_id: quote.config.id,
        fee_code: quote.feeCode,
        amount_paise: amounts.payablePaise,
        base_amount_paise: amounts.basePaise,
        gst_paise: amounts.gstPaise,
        discount_paise: amounts.walletPaise,
        status: 'created',
        gateway: 'razorpay',
        metadata: { context: quote.context, listAmountPaise: amounts.listPaise, walletRedeemedPaise: amounts.walletPaise, platform: ctx.platform, appVersion: ctx.appVersion, installId: ctx.installId } as never,
      })
      .returning(['id', 'public_code', 'created_at'])
      .executeTakeFirstOrThrow()

    if (amounts.walletPaise > 0) {
      await trx
        .insertInto('wallet_ledger')
        .values({ user_id: payer.userId, amount_paise: -amounts.walletPaise, entry_type: 'checkout_redemption', transaction_id: txn.id, description: `Used at checkout · ${txn.public_code}`, idempotency_key: `redeem:${txn.id}` })
        .execute()
    }

    let order: { id: string }
    try {
      order = await withTimeout(gateway.createOrder({ amountPaise: amounts.payablePaise, receipt: txn.public_code, notes: { transactionId: txn.id, feeCode: quote.feeCode, userId: payer.userId } }), GATEWAY_TIMEOUT_MS)
    } catch {
      throw gatewayError('Payments are temporarily unavailable. Try again in a minute.') // rolls back the order and the wallet debit
    }
    await trx.updateTable('transactions').set({ gateway_order_id: order.id }).where('id', '=', txn.id).execute()

    await audit(trx, {
      actorType: 'app_user',
      actorId: payer.userId,
      action: 'app.payment_started',
      module: 'app.payments',
      entityType: 'transaction',
      entityId: txn.id,
      newValues: { feeCode: quote.feeCode, amountPaise: amounts.payablePaise, walletPaise: amounts.walletPaise },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })

    return {
      transactionId: txn.id,
      publicCode: txn.public_code,
      status: 'created' as const,
      expiresAt: new Date(txn.created_at.getTime() + ORDER_EXPIRY_MINUTES * 60_000).toISOString(),
      checkout: await checkoutOptions(payer, { id: txn.id, gateway_order_id: order.id, amount_paise: amounts.payablePaise, fee_code: quote.feeCode }, quote.config.name),
    }
  })

  await putIdempotent(idemKey, 201, { bodyHash, response })
  return response
}

// ---- status model (BR-43.10) ----

type TxnView = {
  id: string
  public_code: string
  status: string
  purpose: string
  amount_paise: number | string
  method: string | null
  failure_code: string | null
  failure_reason: string | null
  gateway_order_id: string | null
  updated_at: Date
  created_at: Date
  metadata: Record<string, unknown>
}

const SUPPORTED_PURPOSES = ['subscription', 'teacher_registration']

export function appStatus(t: TxnView): 'pending' | 'processing' | 'success' | 'failed' | 'expired' | 'refunded' {
  switch (t.status) {
    case 'created':
      return 'pending'
    case 'authorized':
      return 'processing'
    case 'captured':
      // Money is in but access is only granted once fulfilment ran (normally < 2 s).
      return SUPPORTED_PURPOSES.includes(t.purpose) && !t.metadata.fulfilment ? 'processing' : 'success'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'expired'
    default:
      return 'refunded'
  }
}

const presentFulfilment = (t: TxnView) => {
  const f = t.metadata.fulfilment as Fulfilment | undefined
  if (f) return { type: f.type, state: f.state, ...(f.subscriptionId ? { subscriptionId: f.subscriptionId } : {}), ...(f.endsAt ? { endsAt: f.endsAt } : {}), ...(f.queued ? { queued: true } : {}) }
  if (t.status === 'captured' && SUPPORTED_PURPOSES.includes(t.purpose)) return { type: t.purpose, state: 'pending' as const }
  return null
}

const TXN_COLUMNS = ['id', 'public_code', 'status', 'purpose', 'amount_paise', 'method', 'failure_code', 'failure_reason', 'gateway_order_id', 'updated_at', 'created_at', 'metadata'] as const

const loadOwn = (payer: Payer, id: string) =>
  db.selectFrom('transactions').select(TXN_COLUMNS).where('id', '=', id).where('user_id', '=', payer.userId).executeTakeFirst() as Promise<TxnView | undefined>

// ---- POST /payments/verify (BR-43.8) ----

export async function verifyPayment(payer: Payer, body: VerifyBody, ctx: RequestContext) {
  await limit(`pay-verify:${payer.userId}`, 20, 60_000)

  const txn = await loadOwn(payer, body.transactionId)
  if (!txn) throw notFound('This is no longer available.')

  if (txn.gateway_order_id !== body.razorpayOrderId || !signatureMatches(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature)) {
    // A client "success" is never trusted. The mismatch is recorded for the security review (Admin M40 counts these).
    await audit(db, { actorType: 'app_user', actorId: payer.userId, action: 'app.payment_signature_mismatch', module: 'app.payments', entityType: 'transaction', entityId: txn.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId })
    throw paymentFailed("We couldn't confirm this payment.", { reason: 'signature_mismatch' })
  }

  // The signature is valid: remember the payment and move created/failed -> authorized (never away from captured).
  await db
    .updateTable('transactions')
    .set({ gateway_payment_id: body.razorpayPaymentId, status: 'authorized' })
    .where('id', '=', txn.id)
    .where('status', 'in', ['created', 'failed'])
    .execute()

  await sql`update transactions set metadata = metadata || ${JSON.stringify({ lastAttemptAt: new Date().toISOString() })}::jsonb where id = ${txn.id}`.execute(db)

  // Fulfilment only ever follows what the gateway itself says (the webhook does the same through applyCapture).
  const payment = await withTimeout(gateway.fetchPayment(body.razorpayPaymentId), 5000).catch(() => null)
  if (payment?.status === 'captured') await applyCapture(payment)
  else if (payment?.status === 'failed') await applyFailure(payment)

  const fresh = (await loadOwn(payer, txn.id))!
  const status = appStatus(fresh)
  return {
    transactionId: fresh.id,
    status,
    fulfilment: presentFulfilment(fresh),
    ...(status === 'processing' || status === 'pending' ? { nextPollAfterMs: 2000 } : {}),
  }
}

// ---- GET /payments/:id/status (BR-43.10) ----

const SYNC_AFTER_MS = 20_000

// "More than 20 s after verify": the moment the app last reported a payment, or the order's creation if it never did.
const lastAttemptAt = (t: TxnView) => (typeof t.metadata.lastAttemptAt === 'string' ? new Date(t.metadata.lastAttemptAt) : t.created_at)

export async function getStatus(payer: Payer, transactionId: string) {
  await limit(`pay-status:${payer.userId}`, 60, 60_000)

  let txn = await loadOwn(payer, transactionId)
  if (!txn) throw notFound('This is no longer available.')

  // A payment can complete without the app ever calling verify (UPI app in front, app killed): ask the gateway, at most
  // once per 10 s per order, and apply what it says idempotently.
  if (['created', 'authorized'].includes(txn.status) && txn.gateway_order_id && Date.now() - lastAttemptAt(txn).getTime() > SYNC_AFTER_MS) {
    const gate = await hitRateLimit(`paysync:${txn.id}`, 1, 10_000)
    if (gate.allowed) {
      const payments = await gateway.fetchOrderPayments(txn.gateway_order_id).catch(() => [])
      const captured = payments.find((p) => p.status === 'captured')
      const failed = payments.filter((p) => p.status === 'failed').at(-1)
      if (captured) await applyCapture(captured)
      else if (failed && !payments.some((p) => p.status === 'authorized' || p.status === 'created')) await applyFailure(failed)
      txn = (await loadOwn(payer, transactionId))!
    }
  }

  const status = appStatus(txn)
  return {
    transactionId: txn.id,
    publicCode: txn.public_code,
    status,
    rawStatus: txn.status,
    amountPaise: Number(txn.amount_paise),
    method: txn.method,
    failure: status === 'failed' ? { code: txn.failure_code, reason: txn.failure_reason } : null,
    fulfilment: presentFulfilment(txn),
    invoiceAvailable: false, // invoices are generated by Admin M40
    canRetry: status === 'failed',
    nextPollAfterMs: status === 'pending' || status === 'processing' ? 2000 : null,
  }
}
