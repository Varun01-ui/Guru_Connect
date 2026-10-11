import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, uuidParam, upperCase } from '../../lib/masters/query.js'

export const STATE_TYPES = ['state', 'union_territory'] as const

// FR-8 section 5. The code is upper-cased before the check so "kl" is accepted as KL.
const countryId = z.string({ required_error: 'Pick an active parent record.', invalid_type_error: 'Pick an active parent record.' }).uuid('Pick an active parent record.')
export const stateName = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'State name must be 2–60 characters.').max(60, 'State name must be 2–60 characters.'))
export const stateCode = z.string().transform(upperCase).pipe(z.string().regex(/^[A-Z0-9]{1,5}$/, 'Code uses 1–5 capital letters or digits.'))
export const stateType = z.enum(STATE_TYPES, { errorMap: () => ({ message: 'Pick a value from the list.' }) })
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createStateSchema = z
  .object({ countryId, name: stateName, code: stateCode, type: stateType.default('state'), isActive: isActive.default(true), sortOrder: sortOrder.default(0) })
  .strict()

export const patchStateSchema = z
  .object({ countryId: countryId.optional(), name: stateName.optional(), code: stateCode.optional(), type: stateType.optional(), isActive: isActive.optional(), sortOrder: sortOrder.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'code', 'type', 'countryId', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  countryId: uuidParam.optional(),
  type: stateType.optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export const importQuerySchema = z.object({ dryRun: boolParam.optional() })

// One row of the import file, after the header check. Blank type means "state".
export const importRowSchema = z.object({
  countryIso2: z.string().transform(upperCase).pipe(z.string().regex(/^[A-Z]{2}$/, 'country_iso2 must be 2 letters.')),
  name: stateName,
  code: stateCode,
  type: z
    .string()
    .transform((v) => v.trim().toLowerCase().replace(/[\s-]+/g, '_') || 'state')
    .pipe(stateType),
})

export type CreateStateInput = z.infer<typeof createStateSchema>
export type PatchStateInput = z.infer<typeof patchStateSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
