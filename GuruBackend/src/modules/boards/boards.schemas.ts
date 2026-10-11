import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, uuidParam } from '../../lib/masters/query.js'

export const BOARD_TYPES = ['national', 'state', 'international', 'university', 'other'] as const

// FR-13 section 5.
const name = z.string().transform(collapseSpaces).pipe(z.string().min(3, 'Full name must be 3–120 characters.').max(120, 'Full name must be 3–120 characters.'))
const shortName = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Short name must be 2–40 characters.').max(40, 'Short name must be 2–40 characters.'))
const type = z.enum(BOARD_TYPES, { errorMap: () => ({ message: 'Pick a value from the list.' }) })
const stateId = z.string().uuid('Pick an active parent record.').nullable()
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const STATE_REQUIRED = 'Pick the state for a state board.'
export const STATE_NOT_ALLOWED = 'Only state boards have a state.'

export const createBoardSchema = z
  .object({ name, shortName, type, stateId: stateId.default(null), isActive: isActive.default(true), sortOrder: sortOrder.default(0) })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'state' && !v.stateId) ctx.addIssue({ code: 'custom', path: ['stateId'], message: STATE_REQUIRED })
    if (v.type !== 'state' && v.stateId) ctx.addIssue({ code: 'custom', path: ['stateId'], message: STATE_NOT_ALLOWED })
  })

// The type/state pairing of a PATCH depends on the stored row too, so it is checked in the service.
export const patchBoardSchema = z
  .object({ name: name.optional(), shortName: shortName.optional(), type: type.optional(), stateId: stateId.optional(), isActive: isActive.optional(), sortOrder: sortOrder.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'shortName', 'type', 'stateId', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  type: type.optional(),
  stateId: uuidParam.optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export type CreateBoardInput = z.infer<typeof createBoardSchema>
export type PatchBoardInput = z.infer<typeof patchBoardSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
