import { z } from 'zod'

const indianPhone = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid Indian mobile number.')
const appRole = z.enum(['parent', 'student', 'teacher', 'institute_staff'])

export const otpRequestSchema = z.object({
  phone: indianPhone,
})

export const otpVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  intendedRole: appRole.optional(),
})

export const emailLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  intendedRole: appRole.optional(),
})

export const emailOtpRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
})

export const passwordForgotSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
})

export const passwordResetSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z
    .string()
    .min(8)
    .max(72)
    .regex(/[A-Za-z]/, 'Password needs at least one letter.')
    .regex(/[0-9]/, 'Password needs at least one digit.'),
})

export const googleSignInSchema = z.object({
  idToken: z.string().min(1),
  intendedRole: appRole.optional(),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})
