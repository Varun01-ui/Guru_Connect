import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam } from '../../lib/masters/query.js'

// FR-15 section 5. The slug is generated from the name and is not part of the request.
const name = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Name must be 2–50 characters.').max(50, 'Name must be 2–50 characters.'))
// Blank means "no description"; the column is nullable.
const description = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))
  .pipe(z.string().max(200, 'Description can be up to 200 characters.').nullable())
const iconFileId = z.string().uuid('Pick an uploaded category icon.').nullable()
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createTeacherCategorySchema = z
  .object({ name, description: description.default(null), iconFileId: iconFileId.default(null), isActive: isActive.default(true), sortOrder: sortOrder.default(0) })
  .strict()

export const patchTeacherCategorySchema = z
  .object({ name: name.optional(), description: description.optional(), iconFileId: iconFileId.optional(), isActive: isActive.optional(), sortOrder: sortOrder.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'slug', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export type CreateTeacherCategoryInput = z.infer<typeof createTeacherCategorySchema>
export type PatchTeacherCategoryInput = z.infer<typeof patchTeacherCategorySchema>
export type ListQuery = z.infer<typeof listQuerySchema>
