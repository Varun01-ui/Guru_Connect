import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, upperCase } from '../../lib/masters/query.js'

// FR-14.S1: app logic keys on these five codes, so they can't be removed, deactivated or have their flags changed.
export const SYSTEM_CODES = ['ONLINE', 'OFFLINE', 'HOME_TUITION', 'HYBRID', 'BATCH'] as const

// FR-14 section 5. The code is upper-cased before the check so "recorded" is accepted as RECORDED.
const name = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Name must be 2–40 characters.').max(40, 'Name must be 2–40 characters.'))
const code = z.string().transform(upperCase).pipe(z.string().regex(/^[A-Z_]{3,30}$/, 'Code uses 3–30 capital letters or underscores.'))
// Blank means "no description"; the column is nullable.
const description = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))
  .pipe(z.string().max(200, 'Description can be up to 200 characters.').nullable())
const flag = (label: string) => z.boolean({ invalid_type_error: `${label} must be true or false.`, required_error: `${label} must be true or false.` })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createTeachingModeSchema = z
  .object({
    name,
    code,
    description: description.default(null),
    requiresLocation: flag('Needs location').default(true),
    isActive: flag('Active').default(true),
    sortOrder: sortOrder.default(0),
  })
  .strict()

// `code` is accepted so that trying to change it answers CONFLICT_STATE rather than a generic validation error;
// sending the current value is a harmless no-op.
export const patchTeachingModeSchema = z
  .object({
    name: name.optional(),
    code: code.optional(),
    description: description.optional(),
    requiresLocation: flag('Needs location').optional(),
    isActive: flag('Active').optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'code', 'requiresLocation', 'sortOrder'] as const
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

export type CreateTeachingModeInput = z.infer<typeof createTeachingModeSchema>
export type PatchTeachingModeInput = z.infer<typeof patchTeachingModeSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
