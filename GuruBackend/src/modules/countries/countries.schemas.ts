import { z } from 'zod'

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')
const upper = (s: string) => s.trim().toUpperCase()

// FR-7 section 5. Codes are upper-cased before the check so "in" is accepted as "IN".
const name = z.string().transform(collapse).pipe(z.string().min(2, 'Country name must be 2–60 characters.').max(60, 'Country name must be 2–60 characters.'))
const iso2 = z.string().transform(upper).pipe(z.string().regex(/^[A-Z]{2}$/, 'ISO alpha-2 must be exactly 2 letters.'))
const iso3 = z.string().transform(upper).pipe(z.string().regex(/^[A-Z]{3}$/, 'ISO alpha-3 must be exactly 3 letters.'))
const phoneCode = z.string().trim().regex(/^\+\d{1,4}$/, 'Dialling code looks like +91.')
const currencyCode = z.string().transform(upper).pipe(z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code.'))
const isActive = z.boolean({ invalid_type_error: 'Active must be true or false.', required_error: 'Active must be true or false.' })
const sortOrder = z.number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' }).int('Order must be a whole number.').min(0, 'Order must be 0–9,999.').max(9999, 'Order must be 0–9,999.')

export const createCountrySchema = z
  .object({
    name,
    iso2,
    iso3,
    phoneCode,
    currencyCode,
    isActive: isActive.default(true),
    sortOrder: sortOrder.default(0),
  })
  .strict()

export const patchCountrySchema = z
  .object({
    name: name.optional(),
    iso2: iso2.optional(),
    iso3: iso3.optional(),
    phoneCode: phoneCode.optional(),
    currencyCode: currencyCode.optional(),
    isActive: isActive.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const reasonBodySchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().default({})

export const DROPDOWN_FIELDS = ['id', 'name', 'iso2', 'iso3', 'phoneCode', 'currencyCode', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

const bool = z.enum(['true', 'false']).transform((v) => v === 'true')

export const SORT_FIELDS = ['name', 'sortOrder', 'createdAt'] as const

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().min(1).max(100).optional(),
  active: bool.optional(),
  includeDeleted: bool.optional(),
  sort: z
    .string()
    .regex(/^(name|sortOrder|createdAt):(asc|desc)$/, 'Sort by name, sortOrder or createdAt, e.g. name:asc.')
    .optional(),
  fields: z
    .string()
    .transform((s) => s.split(',').map((f) => f.trim()).filter(Boolean))
    .pipe(z.array(z.enum(DROPDOWN_FIELDS, { errorMap: () => ({ message: 'Unknown field.' }) })).min(1))
    .optional(),
})

export type CreateCountryInput = z.infer<typeof createCountrySchema>
export type PatchCountryInput = z.infer<typeof patchCountrySchema>
export type ListQuery = z.infer<typeof listQuerySchema>
