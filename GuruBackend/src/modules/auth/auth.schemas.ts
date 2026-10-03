import { z } from 'zod'
import { passwordPolicyIssues } from '../../lib/passwordPolicy.js'

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().default(false),
})

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
})

// Context-free part of FR-1.10 (length, character classes, common passwords). The email/name check needs the
// account, so the service runs passwordPolicyIssues again with that context once the token is validated.
const passwordPolicy = z.string().superRefine((value, ctx) => {
  for (const message of passwordPolicyIssues(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
})

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: passwordPolicy,
})

export const validateResetTokenQuerySchema = z.object({
  token: z.string().min(20).max(200),
})

const otpPhone = z
  .string()
  .trim()
  .regex(/^\d{10}$/, 'Enter a 10-digit mobile number')

export const otpRequestSchema = z.object({
  phone: otpPhone,
})

export const otpVerifySchema = z.object({
  phone: otpPhone,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  rememberMe: z.boolean().default(false),
})

export const otpLogsQuerySchema = z.object({
  phone: otpPhone,
})
