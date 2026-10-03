import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'

// The payment gateway behind one interface. No Razorpay account exists yet, so the only implementation is an
// in-memory fake that behaves like the parts of Razorpay M43 uses (orders, payments, signatures). A real driver
// implements the same interface and is bound to `gateway` below; nothing else changes.
export type GatewayPayment = {
  id: string
  orderId: string
  status: 'created' | 'authorized' | 'captured' | 'failed'
  method: 'upi' | 'card' | 'netbanking' | null
  // Only ever hashed (payerFingerprint); the raw value is never stored.
  instrument: string | null
  errorCode: string | null
  errorDescription: string | null
}

export interface PaymentGateway {
  keyId: string
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>
  fetchPayment(paymentId: string): Promise<GatewayPayment | null>
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>
  signature(orderId: string, paymentId: string): string
}

export const signCheckout = (orderId: string, paymentId: string): string => createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')

export function signatureMatches(orderId: string, paymentId: string, given: string): boolean {
  const expected = Buffer.from(signCheckout(orderId, paymentId))
  const actual = Buffer.from(given)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 14).padEnd(14, 'x')}`

type FakeOrder = { id: string; amountPaise: number; receipt: string; notes: Record<string, string> }

export const fakeGateway = {
  keyId: env.RAZORPAY_KEY_ID,
  orders: new Map<string, FakeOrder>(),
  payments: new Map<string, GatewayPayment>(),
  failNextOrder: false,

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    if (this.failNextOrder) {
      this.failNextOrder = false
      throw new Error('gateway down')
    }
    const order = { id: id('order'), amountPaise: input.amountPaise, receipt: input.receipt, notes: input.notes }
    this.orders.set(order.id, order)
    return { id: order.id }
  },
  async fetchPayment(paymentId: string) {
    return this.payments.get(paymentId) ?? null
  },
  async fetchOrderPayments(orderId: string) {
    return [...this.payments.values()].filter((p) => p.orderId === orderId)
  },
  signature: signCheckout,

  // Test / dev helper standing in for the customer paying in Checkout.
  simulatePayment(orderId: string, over: Partial<Omit<GatewayPayment, 'id' | 'orderId'>> = {}): GatewayPayment {
    const payment: GatewayPayment = { id: id('pay'), orderId, status: 'captured', method: 'upi', instrument: 'lakshmi@okbank', errorCode: null, errorDescription: null, ...over }
    this.payments.set(payment.id, payment)
    return payment
  },
  reset() {
    this.orders.clear()
    this.payments.clear()
    this.failNextOrder = false
  },
}

// The gateway the app uses. Swap this single binding for a Razorpay driver once credentials exist.
export const gateway: PaymentGateway & typeof fakeGateway = fakeGateway
