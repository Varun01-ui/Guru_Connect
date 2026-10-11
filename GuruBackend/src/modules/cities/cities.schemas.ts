import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, uuidParam } from '../../lib/masters/query.js'

// FR-9 section 5.
const stateId = z.string({ required_error: 'Pick an active parent record.', invalid_type_error: 'Pick an active parent record.' }).uuid('Pick an active parent record.')
const name = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'City name must be 2–60 characters.').max(60, 'City name must be 2–60 characters.'))
const slug = z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9-]{2,60}$/, 'Slug uses 2–60 lower-case letters, digits or hyphens.'))
// Coordinates are kept to 6 decimals (about 10 cm), which is what the column stores.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const latitude = z.number({ invalid_type_error: 'Latitude must be a number.' }).min(-90, 'Latitude must be between -90 and 90.').max(90, 'Latitude must be between -90 and 90.').transform(round6).nullable()
const longitude = z.number({ invalid_type_error: 'Longitude must be a number.' }).min(-180, 'Longitude must be between -180 and 180.').max(180, 'Longitude must be between -180 and 180.').transform(round6).nullable()
const tier = z.union([z.literal(1), z.literal(2), z.literal(3)], { errorMap: () => ({ message: 'Tier is 1, 2 or 3.' }) }).nullable()
const flag = (label: string) => z.boolean({ invalid_type_error: `${label} must be true or false.`, required_error: `${label} must be true or false.` })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createCitySchema = z
  .object({
    stateId,
    name,
    slug: slug.optional(),
    latitude: latitude.default(null),
    longitude: longitude.default(null),
    tier: tier.default(null),
    isServiceable: flag('Serviceable').default(false),
    isActive: flag('Active').default(true),
    sortOrder: sortOrder.default(0),
  })
  .strict()

export const patchCitySchema = z
  .object({
    stateId: stateId.optional(),
    name: name.optional(),
    slug: slug.optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    tier: tier.optional(),
    isServiceable: flag('Serviceable').optional(),
    isActive: flag('Active').optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const DROPDOWN_FIELDS = ['id', 'name', 'slug', 'stateId', 'tier', 'isServiceable', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  serviceable: boolParam.optional(),
  countryId: uuidParam.optional(),
  stateId: uuidParam.optional(),
  tier: z.enum(['1', '2', '3']).transform(Number).optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export type CreateCityInput = z.infer<typeof createCitySchema>
export type PatchCityInput = z.infer<typeof patchCitySchema>
export type ListQuery = z.infer<typeof listQuerySchema>
