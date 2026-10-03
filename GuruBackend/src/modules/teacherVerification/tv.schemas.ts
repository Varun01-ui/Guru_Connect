import { z } from 'zod'

const uuid = z.string().uuid()

// FR-16.9 reason codes for a teacher; documents also allow the image-specific ones (section 5).
export const TEACHER_REASON_CODES = ['DOC_UNREADABLE', 'NAME_MISMATCH', 'QUALIFICATION_UNVERIFIED', 'FORGED_DOCUMENT', 'DUPLICATE_ACCOUNT', 'UNDERAGE', 'OTHER'] as const
export const DOCUMENT_REASON_CODES = [...TEACHER_REASON_CODES, 'BLURRY', 'CROPPED', 'EXPIRED', 'WRONG_DOCUMENT'] as const

const PICK_REASON = 'Pick a reason and add a note for the teacher.'
// Shown to the teacher, so no internal jargon: just length-checked here (wording is the reviewer's responsibility).
const teacherNote = z.string({ required_error: PICK_REASON }).trim().min(10, PICK_REASON).max(500, PICK_REASON)

export const documentDecisionSchema = z
  .object({
    reasonCode: z.enum(DOCUMENT_REASON_CODES, { errorMap: () => ({ message: PICK_REASON }) }),
    note: teacherNote,
  })
  .strict()

export const rejectTeacherSchema = z
  .object({
    reasonCode: z.enum(TEACHER_REASON_CODES, { errorMap: () => ({ message: PICK_REASON }) }),
    note: teacherNote,
  })
  .strict()

export const approveTeacherSchema = z
  .object({
    grantBadge: z.boolean().default(true),
    note: z.string().trim().min(1).max(500).nullish(),
    overrideDuplicate: z.boolean().default(false),
    reason: z.string().trim().min(10, 'Add a reason (10–500 characters).').max(500, 'Add a reason (10–500 characters).').optional(),
  })
  .strict()

export const noteSchema = z.object({ note: z.string().trim().min(1, 'Write a note.').max(2000, 'Notes can be up to 2,000 characters.'), isInternal: z.boolean().default(true) }).strict()

export const sendBackSchema = z.object({ message: z.string().trim().min(10, 'Write a message of 10–500 characters.').max(500, 'Write a message of 10–500 characters.') }).strict()

export const forceQuerySchema = z.object({ force: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })

const PAGE_SIZES = [10, 20, 50, 100] as const
const asArray = (v: unknown) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

export const queueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'pageSize must be 10, 20, 50 or 100.').default(20),
  status: z.preprocess(asArray, z.array(z.enum(['pending', 'under_review', 'reupload_requested'])).optional()),
  sla: z.enum(['green', 'amber', 'red']).optional(),
  assigned: z.enum(['me', 'unassigned', 'anyone']).default('anyone'),
  cityId: uuid.optional(),
  categoryId: uuid.optional(),
  hasFailedCheck: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  payment: z.enum(['paid', 'unpaid', 'not_required', 'refunded']).optional(),
  submittedFrom: day.optional(),
  submittedTo: day.optional(),
  q: z.string().trim().min(2).max(100).optional(),
  sort: z.string().regex(/^[A-Za-z]+:(asc|desc)(,[A-Za-z]+:(asc|desc))*$/, 'Invalid sort.').optional(),
})

export const caseQuerySchema = z.object({ cursor: z.string().min(1).max(200).optional() })

const personName = z.string().trim().min(2, 'Enter the full name (2–100 characters).').max(100, 'Enter the full name (2–100 characters).').regex(/^[\p{L}][\p{L} .'-]*$/u, 'Enter the full name (2–100 characters).')

export const createTeacherSchema = z
  .object({
    fullName: personName,
    phone: z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'Enter a valid Indian mobile number.'),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254).nullish(),
    gender: z.enum(['female', 'male', 'other', 'undisclosed']),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.'),
    categoryId: uuid,
    highestQualification: z.string().trim().min(2).max(120),
    experienceYears: z.number().int().min(0).max(60),
    documents: z
      .array(
        z.object({
          docType: z.enum(['aadhaar', 'pan', 'education_certificate', 'professional_certificate', 'experience_letter', 'photo']),
          fileId: uuid,
          title: z.string().trim().min(2).max(120).nullish(),
          docNumberLast4: z.string().regex(/^[A-Za-z0-9]{4}$/, 'Enter the last 4 characters.').nullish(),
        }),
      )
      .max(15)
      .default([]),
    submitForReview: z.boolean().default(false),
  })
  .strict()

export const idParamSchema = z.object({ id: uuid })
