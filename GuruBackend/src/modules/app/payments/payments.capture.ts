import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { db } from '../../../db/index.js'
import type { AppTrx } from '../registration/registration.repository.js'
import { audit } from '../../../lib/audit.js'
import { createNotification } from '../../../lib/notify.js'
import type { GatewayPayment } from '../../../lib/razorpay.js'
import { scheduleRepeatingJob } from '../../../lib/jobs.js'
import { DAY_MS } from './payments.pricing.js'

// PaymentCaptureService (M43 BR-43.11): the one idempotent place where a captured payment becomes access. Called by
// POST /payments/verify and the status sync today, and by the Razorpay webhook job (Admin M40) when that exists.

type TxnRow = {
  id: string
  user_id: string
  payer_type: 'parent' | 'student' | 'teacher' | 'institute'
  purpose: string
  fee_code: string | null
  status: string
  payment_configuration_id: string | null
  amount_paise: number | string
  discount_paise: number | string
  metadata: Record<string, unknown>
}

export type Fulfilment = { type: 'subscription' | 'teacher_registration'; state: 'done' | 'refund_pending'; subscriptionId?: string; endsAt?: string; queued?: boolean }

const fingerprint = (value: string | null) => (value ? createHash('sha256').update(value).digest('hex') : null)

async function lockByOrder(trx: AppTrx, orderId: string): Promise<TxnRow | undefined> {
  const result = await sql<TxnRow>`select id, user_id, payer_type, purpose, fee_code, status, payment_configuration_id, amount_paise, discount_paise, metadata
    from transactions where gateway_order_id = ${orderId} for update`.execute(trx)
  return result.rows[0]
}

const mergeMetadata = (trx: AppTrx, id: string, patch: Record<string, unknown>) =>
  sql`update transactions set metadata = metadata || ${JSON.stringify(patch)}::jsonb where id = ${id}`.execute(trx)

async function fulfilPeriod(trx: AppTrx, txn: TxnRow, subscriberType: 'parent' | 'student' | 'teacher', now: Date): Promise<Fulfilment> {
  const config = await trx.selectFrom('payment_configurations').select(['validity_days', 'fee_code']).where('id', '=', txn.payment_configuration_id!).executeTakeFirstOrThrow()
  const length = (config.validity_days ?? 30) * DAY_MS
  const listPaise = Number(txn.metadata.listAmountPaise ?? Number(txn.amount_paise) + Number(txn.discount_paise))
  const live = await trx
    .selectFrom('subscriptions')
    .select(['id', 'status', 'ends_at'])
    .where('user_id', '=', txn.user_id)
    .where('subscriber_type', '=', subscriberType)
    .where('status', 'in', ['trial', 'active', 'grace', 'free_access'])
    .forUpdate()
    .executeTakeFirst()
  const type = subscriberType === 'teacher' ? ('teacher_registration' as const) : ('subscription' as const)

  if (!live) {
    const endsAt = new Date(now.getTime() + length)
    const row = await trx
      .insertInto('subscriptions')
      .values({ user_id: txn.user_id, subscriber_type: subscriberType, fee_code: config.fee_code, payment_configuration_id: txn.payment_configuration_id, price_paise: listPaise, status: 'active', starts_at: now, ends_at: endsAt, last_transaction_id: txn.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { type, state: 'done', subscriptionId: row.id, endsAt: endsAt.toISOString() }
  }

  if (live.status === 'trial') {
    // Paying ends the trial and starts the paid period immediately (Admin M41 FR-41.2).
    const endsAt = new Date(now.getTime() + length)
    await trx
      .updateTable('subscriptions')
      .set({ status: 'active', trial_ends_at: now, starts_at: now, ends_at: endsAt, fee_code: config.fee_code, payment_configuration_id: txn.payment_configuration_id, price_paise: listPaise, last_transaction_id: txn.id })
      .where('id', '=', live.id)
      .execute()
    return { type, state: 'done', subscriptionId: live.id, endsAt: endsAt.toISOString() }
  }

  if ((live.status === 'active' || live.status === 'grace') && live.ends_at && live.ends_at.getTime() - now.getTime() <= 30 * DAY_MS) {
    // Queued: the Admin M41 job starts it at the current period's end.
    const endsAt = new Date(live.ends_at.getTime() + length)
    await mergeMetadata(trx, txn.id, { pendingPeriod: { subscriptionId: live.id, feeCode: config.fee_code, startsAt: live.ends_at.toISOString(), endsAt: endsAt.toISOString(), priceChangedFrom: listPaise } })
    return { type, state: 'done', subscriptionId: live.id, endsAt: endsAt.toISOString(), queued: true }
  }

  // The purchase stopped being valid between order and capture (e.g. bought twice). The money is taken, so flag it
  // for a system refund request (`duplicate_charge`, Admin M40) instead of granting a second period.
  await mergeMetadata(trx, txn.id, { refundRequest: 'duplicate_charge' })
  return { type, state: 'refund_pending' }
}

async function fulfil(trx: AppTrx, txn: TxnRow, now: Date): Promise<Fulfilment | null> {
  if (txn.purpose === 'subscription' && (txn.payer_type === 'parent' || txn.payer_type === 'student')) return fulfilPeriod(trx, txn, txn.payer_type, now)

  if (txn.purpose === 'teacher_registration') {
    const context = (txn.metadata.context ?? {}) as { renewal?: boolean }
    if (context.renewal) return fulfilPeriod(trx, txn, 'teacher', now)
    // First payment: remember it on the teacher; the 12-month period is created at approval (Admin M16 FR-16.8).
    await trx.updateTable('teachers').set({ registration_transaction_id: txn.id }).where('user_id', '=', txn.user_id).where('registration_transaction_id', 'is', null).execute()
    return { type: 'teacher_registration', state: 'done' }
  }
  // premium / featured / contact unlock / institute registration: fulfilment arrives with their modules (M44, M37, M22).
  return null
}

// Idempotent: a transaction already captured (or refunded) is left alone.
export async function applyCapture(payment: GatewayPayment): Promise<{ transactionId: string; status: string } | null> {
  return db.transaction().execute(async (trx) => {
    const txn = await lockByOrder(trx, payment.orderId)
    if (!txn) return null
    if (['captured', 'refund_pending', 'refunded', 'partially_refunded'].includes(txn.status)) return { transactionId: txn.id, status: txn.status }

    const now = new Date()
    const walletRedeemed = Number(txn.metadata.walletRedeemedPaise ?? 0)
    if (txn.status === 'cancelled' && walletRedeemed > 0) {
      // A late capture on an order whose wallet credit was already handed back: spend it again (the balance may go negative).
      const refunded = await trx.selectFrom('wallet_ledger').select('id').where('idempotency_key', '=', `redeem_refund:${txn.id}`).executeTakeFirst()
      if (refunded) {
        await trx
          .insertInto('wallet_ledger')
          .values({ user_id: txn.user_id, amount_paise: -walletRedeemed, entry_type: 'checkout_redemption', transaction_id: txn.id, description: 'Used at checkout (late payment)', idempotency_key: `redeem_retry:${txn.id}` })
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    }

    await trx
      .updateTable('transactions')
      .set({ status: 'captured', captured_at: now, gateway_payment_id: payment.id, method: payment.method, failure_code: null, failure_reason: null })
      .where('id', '=', txn.id)
      .execute()
    await mergeMetadata(trx, txn.id, { payerFingerprint: fingerprint(payment.instrument) })

    const fulfilment = await fulfil(trx, txn, now)
    if (fulfilment) await mergeMetadata(trx, txn.id, { fulfilment })

    await audit(trx, { actorType: 'system', action: 'app.payment_captured', module: 'app.payments', entityType: 'transaction', entityId: txn.id, newValues: { feeCode: txn.fee_code, purpose: txn.purpose } })
    await createNotification(trx, {
      userId: txn.user_id,
      category: 'payments',
      eventType: 'payment.captured',
      title: 'Payment successful',
      body: 'Thanks! Your payment was received.',
      data: { transactionId: txn.id },
      dedupeKey: `payment.captured:${txn.id}`,
    })
    // HOOKS (out of scope): M46 referral qualification (first_payment), invoice PDF job (Admin M40).
    return { transactionId: txn.id, status: 'captured' }
  })
}

// payment.failed: unless it was already captured. Razorpay allows up to 3 attempts per order, so a later capture
// can still move failed -> captured.
export async function applyFailure(payment: GatewayPayment): Promise<{ transactionId: string; status: string } | null> {
  return db.transaction().execute(async (trx) => {
    const txn = await lockByOrder(trx, payment.orderId)
    if (!txn) return null
    if (!['created', 'authorized', 'failed'].includes(txn.status)) return { transactionId: txn.id, status: txn.status }
    await trx
      .updateTable('transactions')
      .set({ status: 'failed', failure_code: payment.errorCode, failure_reason: payment.errorDescription, gateway_payment_id: payment.id })
      .where('id', '=', txn.id)
      .execute()
    await createNotification(trx, {
      userId: txn.user_id,
      category: 'payments',
      eventType: 'payment.failed',
      title: 'Payment failed',
      body: payment.errorDescription ?? "Your payment didn't go through. Try again.",
      data: { transactionId: txn.id },
      dedupeKey: `payment.failed:${txn.id}:${payment.id}`,
    })
    return { transactionId: txn.id, status: 'failed' }
  })
}

// Orders still `created` after 30 minutes are cancelled (Admin M40's job owns the rule); this module adds the wallet
// credit refund in the same transaction.
export async function cancelStaleOrders(now = new Date(), olderThanMinutes = 30): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000)
  const stale = await db.selectFrom('transactions').select('id').where('status', '=', 'created').where('created_at', '<', cutoff).execute()
  let cancelled = 0
  for (const { id } of stale) {
    const done = await db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('transactions').select(['id', 'user_id', 'status', 'metadata']).where('id', '=', id).forUpdate().executeTakeFirst()
      if (!row || row.status !== 'created') return false
      await trx.updateTable('transactions').set({ status: 'cancelled' }).where('id', '=', id).execute()
      const wallet = Number((row.metadata as Record<string, unknown>).walletRedeemedPaise ?? 0)
      if (wallet > 0) {
        await trx
          .insertInto('wallet_ledger')
          .values({ user_id: row.user_id, amount_paise: wallet, entry_type: 'redemption_refund', transaction_id: id, description: 'Refund: payment session expired', idempotency_key: `redeem_refund:${id}` })
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
      return true
    })
    if (done) cancelled += 1
  }
  return cancelled
}

export function startPaymentJobs() {
  return scheduleRepeatingJob({
    queueName: 'payments-maintenance',
    schedulerId: 'payments-cancel-stale-orders',
    pattern: '*/5 * * * *',
    handler: async () => {
      const n = await cancelStaleOrders()
      if (n > 0) console.log(`[jobs] cancelled ${n} stale payment orders`)
    },
  })
}
