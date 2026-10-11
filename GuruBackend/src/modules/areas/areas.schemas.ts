import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, uuidParam } from '../../lib/masters/query.js'

// FR-10 section 5.
export const PIN = /^[1-9][0-9]{5}$/
export const MAX_PINCODES = 20

const cityId = z.string({ required_error: 'Pick an active parent record.', invalid_type_error: 'Pick an active parent record.' }).uuid('Pick an active parent record.')
export const areaName = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Area name must be 2–80 characters.').max(80, 'Area name must be 2–80 characters.'))
// Sorted so the same set of PIN codes is always the same value (and so an unchanged list is no change).
export const pincodeList = z
  .array(z.string().trim().regex(PIN, 'A PIN code is 6 digits and does not start with 0.'), { invalid_type_error: 'PIN codes must be a list.' })
  .max(MAX_PINCODES, `An area can have up to ${MAX_PINCODES} PIN codes.`)
  .refine((a) => new Set(a).size === a.length, 'Each PIN code can only be listed once.')
  .transform((a) => [...a].sort())
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
export const latitude = z.number({ invalid_type_error: 'Latitude must be a number.' }).min(-90, 'Latitude must be between -90 and 90.').max(90, 'Latitude must be between -90 and 90.').transform(round6).nullable()
export const longitude = z.number({ invalid_type_error: 'Longitude must be a number.' }).min(-180, 'Longitude must be between -180 and 180.').max(180, 'Longitude must be between -180 and 180.').transform(round6).nullable()
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createAreaSchema = z
  .object({ cityId, name: areaName, pincodes: pincodeList.default([]), latitude: latitude.default(null), longitude: longitude.default(null), isActive: isActive.default(true), sortOrder: sortOrder.default(0) })
  .strict()

export const patchAreaSchema = z
  .object({ cityId: cityId.optional(), name: areaName.optional(), pincodes: pincodeList.optional(), latitude: latitude.optional(), longitude: longitude.optional(), isActive: isActive.optional(), sortOrder: sortOrder.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const mergeAreaSchema = z
  .object({
    intoAreaId: z.string({ required_error: 'Pick the area to merge into.', invalid_type_error: 'Pick the area to merge into.' }).uuid('Pick the area to merge into.'),
    reason: z.string().trim().min(1).max(500, 'Reason can be up to 500 characters.').optional(),
  })
  .strict()

export const DROPDOWN_FIELDS = ['id', 'name', 'slug', 'cityId', 'pincodes', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  cityId: uuidParam.optional(),
  hasCoordinates: boolParam.optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export const importQuerySchema = z.object({ dryRun: boolParam.optional(), skipInvalid: boolParam.optional() })
export const pincodeParamSchema = z.object({ pin: z.string().regex(PIN, 'A PIN code is 6 digits and does not start with 0.') })

export type CreateAreaInput = z.infer<typeof createAreaSchema>
export type PatchAreaInput = z.infer<typeof patchAreaSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
