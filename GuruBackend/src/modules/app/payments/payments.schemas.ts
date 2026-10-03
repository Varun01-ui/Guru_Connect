import { z } from 'zod'

const FEE_ERROR = "This item can't be bought here."

export const quoteQuerySchema = z.object({
  feeCode: z.string().min(1, FEE_ERROR),
  useWallet: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  leadId: z.string().uuid().optional(),
  renewal: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

export const createOrderSchema = z.object({
  feeCode: z.string().min(1, FEE_ERROR),
  context: z.object({ leadId: z.string().uuid().nullish(), renewal: z.boolean().nullish() }).default({}),
  useWallet: z.boolean().default(false),
  paymentConfigurationId: z.string().uuid('The price was updated. Please review.'),
  expectedPayablePaise: z.number().int().min(100, 'The price was updated. Please review.'),
})

export const verifyPaymentSchema = z.object({
  transactionId: z.string().uuid('Payment not found.'),
  razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{14}$/, "We couldn't confirm this payment."),
  razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{14}$/, "We couldn't confirm this payment."),
  razorpaySignature: z.string().regex(/^[0-9a-fA-F]{64}$/, "We couldn't confirm this payment."),
})

export const transactionIdParamSchema = z.object({ id: z.string().uuid('Payment not found.') })
