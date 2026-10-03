import { z } from 'zod'
import { basicsObject } from '../teacher/teacher.schemas.js'

const uuid = z.string().uuid()

// BR-17.2: the same personal + experience fields Module 14 sets, plus the public photo and the reason an identity
// field change needs.
export const patchProfileSchema = basicsObject
  .extend({
    profilePhotoFileId: uuid.optional(),
    reason: z.string().trim().min(10, "Tell us why you're changing this").max(500, "Tell us why you're changing this").optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.')

const FEE_UNITS = ['per_hour', 'per_month', 'per_course'] as const

// Amount: the spec allows up to Rs 1,00,000 (10,000,000 paise) while the table CHECK also requires at least Rs 50
// (5,000 paise); the intersection is enforced. Session length: spec 15-180 min, table 30-240, so 30-180.
const feePlanFields = {
  label: z.string().trim().min(2, 'Give this plan a short name').max(60, 'Give this plan a short name'),
  subjectId: uuid.nullable(),
  classFromId: uuid.nullable(),
  classToId: uuid.nullable(),
  teachingModeId: uuid.nullable(),
  feeUnit: z.enum(FEE_UNITS),
  amountPaise: z.number().int().min(5000, 'Enter a valid amount').max(10_000_000, 'Enter a valid amount'),
  sessionsPerWeek: z.number().int().min(1, 'Enter sessions per week').max(14, 'Enter sessions per week').nullable(),
  sessionMinutes: z.number().int().min(30, 'Enter a class length').max(180, 'Enter a class length').nullable(),
  notes: z.string().trim().max(200).nullable(),
}

export const createFeePlanSchema = z
  .object({
    ...feePlanFields,
    subjectId: feePlanFields.subjectId.optional(),
    classFromId: feePlanFields.classFromId.optional(),
    classToId: feePlanFields.classToId.optional(),
    teachingModeId: feePlanFields.teachingModeId.optional(),
    sessionsPerWeek: feePlanFields.sessionsPerWeek.optional(),
    sessionMinutes: feePlanFields.sessionMinutes.optional(),
    notes: feePlanFields.notes.optional(),
  })
  .strict()

export const updateFeePlanSchema = z
  .object(feePlanFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.')

export const idParamSchema = z.object({ id: uuid })
