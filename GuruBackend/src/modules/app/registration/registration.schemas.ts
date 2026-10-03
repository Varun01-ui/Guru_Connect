import { z } from 'zod'

const indianPhone = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid Indian mobile number.')

export const referralValidateSchema = z.object({
  code: z.string().min(1),
})

export const registerParentSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  mobile: indianPhone,
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  stateId: z.string().uuid(),
  cityId: z.string().uuid(),
  areaId: z.string().uuid().optional(),
  marketingOptIn: z.boolean().default(false),
  referralCode: z
    .string()
    .regex(/^[A-Za-z0-9]{4,20}$/, 'Codes are letters and numbers only.')
    .transform((v) => v.toUpperCase())
    .optional(),
})
