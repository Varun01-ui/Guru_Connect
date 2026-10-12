import { z } from 'zod'
import { GST_RATES_BPS, MAX_AMOUNT_PAISE } from './pc.rules.js'

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

const name = z.string().transform(collapse).pipe(z.string().min(3, 'Name must be 3–60 characters.').max(60, 'Name must be 3–60 characters.'))
const description = z.string().transform(collapse).pipe(z.string().max(200, 'Description can be up to 200 characters.'))
const amountPaise = z
  .number({ invalid_type_error: 'Price must be a whole number of paise.', required_error: 'Enter a price.' })
  .int('Price must be a whole number of paise.')
  .min(0, 'Price must be between ₹0 and ₹1,00,000.')
  .max(MAX_AMOUNT_PAISE, 'Price must be between ₹0 and ₹1,00,000.')
const gstRateBps = z
  .number({ invalid_type_error: 'Choose a GST rate.' })
  .refine((v) => (GST_RATES_BPS as readonly number[]).includes(v), 'GST must be 0%, 5%, 12%, 18% or 28%.')
const billingPeriod = z.enum(['one_time', 'monthly', 'quarterly', 'yearly', 'per_30_days', 'per_use'], { errorMap: () => ({ message: 'Choose a billing period.' }) })
const validityDays = z.number({ invalid_type_error: 'Validity must be a whole number of days.' }).int('Validity must be a whole number of days.')
const trialDays = z.number({ invalid_type_error: 'Trial must be 0–90 days.' }).int('Trial must be 0–90 days.').min(0, 'Trial must be 0–90 days.').max(90, 'Trial must be 0–90 days.')
const flag = (message: string) => z.boolean({ invalid_type_error: message, required_error: message })

// FR-5.2. Every field is optional: a draft starts as a copy of the current version and only the sent fields change.
export const draftSchema = z
  .object({
    isEnabled: flag('Choose on or off.').optional(),
    amountPaise: amountPaise.optional(),
    gstInclusive: flag('Choose whether the price includes GST.').optional(),
    gstRateBps: gstRateBps.optional(),
    billingPeriod: billingPeriod.optional(),
    validityDays: validityDays.nullable().optional(),
    trialDays: trialDays.optional(),
    name: name.optional(),
    description: description.nullable().optional(),
  })
  .strict()
export type DraftInput = z.infer<typeof draftSchema>

const reason = z
  .string({ required_error: 'Add a reason.', invalid_type_error: 'Add a reason.' })
  .transform((s) => s.trim())
  .pipe(z.string().min(5, 'Add a reason.').max(500, 'Keep the reason under 500 characters.'))
const effectiveFrom = z.string().datetime({ offset: true, message: 'Pick a time from now up to one year ahead.' })

export const publishSchema = z.object({ effectiveFrom: effectiveFrom.optional(), reason, confirmLargeChange: z.boolean().optional() }).strict()
export const toggleSchema = z.object({ enabled: flag('Choose on or off.'), reason }).strict()
export const cancelSchema = z.object({ reason }).strict()
export const restoreSchema = z.object({ effectiveFrom: effectiveFrom.optional(), reason, confirmLargeChange: z.boolean().optional() }).strict()

export const versionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['draft', 'scheduled', 'active', 'superseded', 'cancelled']).optional(),
})
export type VersionsQuery = z.infer<typeof versionsQuerySchema>

const ACTIONS = ['created', 'updated', 'published', 'scheduled', 'activated', 'superseded', 'cancelled', 'enabled', 'disabled'] as const
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
  feeCode: z.string().optional(),
  action: z.enum(ACTIONS).optional(),
  adminId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})
export type HistoryQuery = z.infer<typeof historyQuerySchema>
