import { z } from 'zod'
import { containsContactInfo } from '../../../lib/contact.js'

const uuid = z.string().uuid()


export const ageOn = (dob: string, today = new Date()): number => {
  const [y, mo, d] = dob.split('-').map(Number) as [number, number, number]
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1
  return age
}

export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.')
  .refine((v) => ageOn(v) >= 18 && ageOn(v) <= 90, 'You must be at least 18 to register as a teacher')

const genderSchema = z.enum(['female', 'male', 'other', 'undisclosed'], { errorMap: () => ({ message: 'Select an option' }) })
const fullNameSchema = z.string().trim().min(2, 'Enter your full name as on your ID').max(100, 'Enter your full name as on your ID')

export const registerTeacherSchema = z.object({
  fullName: fullNameSchema,
  gender: genderSchema,
  dateOfBirth: dateOfBirthSchema,
  categoryId: uuid.describe('Choose a category'),
  referralCode: z
    .string()
    .regex(/^[A-Za-z0-9]{4,20}$/, 'Codes are letters and numbers only.')
    .transform((v) => v.toUpperCase())
    .nullish(),
})

// Languages: the "supported list" is not defined in the spec pack, so any 1-10 short names are accepted.
const languagesSchema = z.array(z.string().trim().min(2).max(40)).min(1, 'Add at least one language').max(10, 'Add at least one language')

export const basicsObject = z
  .object({
    // personal details screen
    fullName: fullNameSchema,
    gender: genderSchema,
    dateOfBirth: dateOfBirthSchema,
    email: z.string().trim().toLowerCase().email('Enter a valid email').max(254).nullable(),
    categoryId: uuid,
    languages: languagesSchema,
    // experience screen
    experienceYears: z.number().int().min(0).max(60),
    highestQualification: z.string().trim().min(2, 'Enter your highest qualification').max(120, 'Enter your highest qualification'),
    bio: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => !containsContactInfo(v), 'Remove phone numbers, emails or links'),
    feePerHourPaise: z.number().int().min(0, 'Enter a fee up to ₹1,000/hour').max(100_000, 'Enter a fee up to ₹1,000/hour').nullable(),
    demoAvailable: z.boolean(),
  })
  .partial()
  .strict()

export const basicsSchema = basicsObject.refine((v) => Object.keys(v).length > 0, 'Send at least one field.')

export const PERSONAL_FIELDS = ['fullName', 'gender', 'dateOfBirth', 'email', 'categoryId', 'languages'] as const
export const EXPERIENCE_FIELDS = ['experienceYears', 'highestQualification', 'bio', 'feePerHourPaise', 'demoAvailable'] as const

const currentYear = () => new Date().getFullYear()
const QUALIFICATION_LEVELS = ['secondary', 'senior_secondary', 'diploma', 'graduate', 'postgraduate', 'doctorate', 'professional', 'certification'] as const

const qualificationFields = {
  level: z.enum(QUALIFICATION_LEVELS, { errorMap: () => ({ message: 'Select a level' }) }),
  degree: z.string().trim().min(2, 'Enter your degree or certification name').max(120, 'Enter your degree or certification name'),
  institution: z.string().trim().min(2, 'Enter your institution name').max(120, 'Enter your institution name'),
  yearCompleted: z
    .number()
    .int()
    .min(1960, 'Enter a valid year')
    .refine((y) => y <= currentYear(), 'Enter a valid year'),
  grade: z.string().trim().max(40).nullable(),
  isHighest: z.boolean(),
}

export const createQualificationSchema = z
  .object({ ...qualificationFields, yearCompleted: qualificationFields.yearCompleted.nullish(), grade: qualificationFields.grade.optional(), isHighest: qualificationFields.isHighest.default(false) })
  .strict()

export const updateQualificationSchema = z
  .object(qualificationFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.')

export const idParamSchema = z.object({ id: uuid })

export const setSubjectsSchema = z.object({
  items: z
    .array(z.object({ subjectId: uuid, isPrimary: z.boolean().default(false), experienceYears: z.number().int().min(0).max(60).nullish() }))
    .min(1, 'Add at least one subject')
    .max(10, 'You can add up to 10 subjects.'),
})

export const setClassesSchema = z.object({
  items: z.array(z.object({ classId: uuid, boardId: uuid.nullish() })).min(1, 'Add at least one class').max(20, 'You can add up to 20 classes.'),
})

// The request shape for teaching modes is not given in the spec pack beyond "items, 1-4, unique": both
// `[{ teachingModeId }]` and a bare id list are accepted.
export const setTeachingModesSchema = z.object({
  items: z
    .array(z.union([uuid, z.object({ teachingModeId: uuid })]).transform((v) => (typeof v === 'string' ? v : v.teachingModeId)))
    .min(1, 'Select at least one teaching mode')
    .max(4, 'You can pick up to 4 teaching modes.'),
})

export const setLocationsSchema = z.object({
  items: z
    .array(
      z.object({
        cityId: uuid,
        areaId: uuid.nullish(),
        isPrimary: z.boolean().default(false),
        travelRadiusKm: z.number().int().min(2, "Set how far you're willing to travel").max(25, "Set how far you're willing to travel").nullish(),
        addressLine: z.string().trim().max(200).nullish(),
        latitude: z.number().min(-90).max(90).nullish(),
        longitude: z.number().min(-180).max(180).nullish(),
      }),
    )
    .max(5, 'You can add up to 5 locations.'),
})
