import { z } from 'zod'

const indianPhone = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid phone number.')

export const registerStudentSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, 'Enter your full name.')
    .max(100, 'Enter your full name.')
    .regex(/^\p{L}[\p{L} .]*$/u, 'Enter your full name.'),
  classId: z.string().uuid('Choose your class.'),
  boardId: z.string().uuid().nullish(),
  schoolName: z.string().trim().max(120).nullish(),
  subjectIds: z.array(z.string().uuid()).max(6, 'Pick up to 6 subjects.').default([]),
  cityId: z.string().uuid('Choose a city.'),
  areaId: z.string().uuid().nullish(),
  parentName: z.string().trim().min(2, "Enter your parent's name.").max(100, "Enter your parent's name.").nullish(),
  parentPhone: indianPhone.nullish(),
  consents: z.object({
    terms: z.literal(true, { errorMap: () => ({ message: 'Accept the Terms to continue.' }) }),
    privacyPolicy: z.literal(true, { errorMap: () => ({ message: 'Accept the Privacy Policy to continue.' }) }),
    marketing: z.boolean().default(false),
  }),
  referralCode: z
    .string()
    .regex(/^[A-Za-z0-9]{4,20}$/, 'Codes are letters and numbers only.')
    .transform((v) => v.toUpperCase())
    .nullish(),
})

export const verifyParentConsentSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
})
