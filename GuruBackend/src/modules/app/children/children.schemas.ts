import { z } from 'zod'

const uuid = z.string().uuid()

// BR-7.2: first name only (data minimisation for minors), letters and spaces.
const childName = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, "Enter your child's first name.")
      .max(40, "Enter your child's first name.")
      .regex(/^[\p{L}\p{M}][\p{L}\p{M} ]*$/u, "Enter your child's first name."),
  )

const schoolName = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().max(120, 'Keep the school name under 120 characters.'))
  .transform((v) => (v === '' ? null : v))
  .nullable()

const subjectIds = z.array(uuid).max(6, 'Choose up to 6 subjects.').refine((ids) => new Set(ids).size === ids.length, 'Each subject can only be chosen once.')
const categoryIds = z.array(uuid).max(4, 'Choose up to 4 teacher types.').refine((ids) => new Set(ids).size === ids.length, 'Each teacher type can only be chosen once.')

export const createChildSchema = z.object({
  childName,
  classId: uuid,
  boardId: uuid.nullable().optional(),
  subjectIds: subjectIds.default([]),
  categoryIds: categoryIds.default([]),
  preferredModeId: uuid.nullable().optional(),
  schoolName: schoolName.optional(),
})

// Any subset of the create fields. `classId` cannot be cleared; the optional ones can be set to null.
export const updateChildSchema = z
  .object({
    childName,
    classId: uuid,
    boardId: uuid.nullable(),
    subjectIds,
    categoryIds,
    preferredModeId: uuid.nullable(),
    schoolName,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.')

export const reorderChildrenSchema = z.object({
  orderedIds: z.array(uuid).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, 'Each child can only appear once.'),
})

export const childIdParamSchema = z.object({ id: uuid })

export type CreateChildBody = z.infer<typeof createChildSchema>
export type UpdateChildBody = z.infer<typeof updateChildSchema>
