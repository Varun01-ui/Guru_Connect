import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, upperCase } from '../../lib/masters/query.js'

export const STAGES = ['pre_primary', 'primary', 'middle', 'secondary', 'senior_secondary', 'undergraduate', 'postgraduate', 'competitive', 'adult'] as const

// FR-11 section 5. The code is upper-cased before the check so "class_11_drop" is accepted as CLASS_11_DROP.
const name = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Name must be 2–40 characters.').max(40, 'Name must be 2–40 characters.'))
const code = z.string().transform(upperCase).pipe(z.string().regex(/^[A-Z0-9_]{2,30}$/, 'Code uses 2–30 capital letters, digits or underscores.'))
const stage = z.enum(STAGES, { errorMap: () => ({ message: 'Pick a value from the list.' }) })
const levelOrder = z
  .number({ invalid_type_error: 'Level order must be a number.', required_error: 'Level order must be a number.' })
  .int('Level order must be a whole number.')
  .min(0, 'Level order must be 0–50.')
  .max(50, 'Level order must be 0–50.')
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })

export const createClassSchema = z.object({ name, code, stage, levelOrder, isActive: isActive.default(true) }).strict()

// `code` is accepted so that trying to change it answers CONFLICT_STATE ("Class codes can't change.") rather than a
// generic validation error; sending the current value is a harmless no-op.
export const patchClassSchema = z
  .object({ name: name.optional(), code: code.optional(), stage: stage.optional(), levelOrder: levelOrder.optional(), isActive: isActive.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'code', 'stage', 'levelOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  stage: z.enum(STAGES, { errorMap: () => ({ message: 'Pick a value from the list.' }) }).optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'levelOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export type CreateClassInput = z.infer<typeof createClassSchema>
export type PatchClassInput = z.infer<typeof patchClassSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
