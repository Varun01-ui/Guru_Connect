import { z } from 'zod'
import { boolParam, collapseSpaces, fieldsParam, pageParam, pageSizeParam, searchParam, sortParam, uuidParam } from '../../lib/masters/query.js'

export const CATEGORIES = ['academic', 'competitive_exam', 'language', 'music_arts', 'coding_skills', 'other'] as const
export const MAX_ALIASES = 15
export const MAX_TRENDING = 10

// FR-12 section 5.
const name = z.string().transform(collapseSpaces).pipe(z.string().min(2, 'Name must be 2–60 characters.').max(60, 'Name must be 2–60 characters.'))
const category = z.enum(CATEGORIES, { errorMap: () => ({ message: 'Pick a value from the list.' }) })
const parentSubjectId = z.string().uuid('Pick an active parent record.').nullable()
// Lower-cased so "Maths" and "maths" are the same alias; the search matches them lower-case too.
export const aliasList = z
  .array(z.string().transform((a) => collapseSpaces(a).toLowerCase()).pipe(z.string().min(2, 'Each alias must be 2–40 characters.').max(40, 'Each alias must be 2–40 characters.')), { invalid_type_error: 'Aliases must be a list.' })
  .max(MAX_ALIASES, `A subject can have up to ${MAX_ALIASES} aliases.`)
  .refine((a) => new Set(a).size === a.length, 'Each alias can only be listed once.')
const iconFileId = z.string().uuid('Pick an uploaded subject icon.').nullable()
const classOrder = (label: string) => z.number({ invalid_type_error: `${label} must be a number.` }).int(`${label} must be a whole number.`).nullable()
const flag = (label: string) => z.boolean({ invalid_type_error: `${label} must be true or false.`, required_error: `${label} must be true or false.` })
const sortOrder = z
  .number({ invalid_type_error: 'Order must be a number.', required_error: 'Order must be a number.' })
  .int('Order must be a whole number.')
  .min(0, 'Order must be 0–9,999.')
  .max(9999, 'Order must be 0–9,999.')

export const createSubjectSchema = z
  .object({
    name,
    category,
    parentSubjectId: parentSubjectId.default(null),
    aliases: aliasList.default([]),
    iconFileId: iconFileId.default(null),
    minClassOrder: classOrder('First class').default(null),
    maxClassOrder: classOrder('Last class').default(null),
    isTrending: flag('Trending').default(false),
    isActive: flag('Active').default(true),
    sortOrder: sortOrder.default(0),
  })
  .strict()

export const patchSubjectSchema = z
  .object({
    name: name.optional(),
    category: category.optional(),
    parentSubjectId: parentSubjectId.optional(),
    aliases: aliasList.optional(),
    iconFileId: iconFileId.optional(),
    minClassOrder: classOrder('First class').optional(),
    maxClassOrder: classOrder('Last class').optional(),
    isTrending: flag('Trending').optional(),
    isActive: flag('Active').optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export const mergeSubjectSchema = z
  .object({
    intoSubjectId: z.string({ required_error: 'Pick the subject to merge into.', invalid_type_error: 'Pick the subject to merge into.' }).uuid('Pick the subject to merge into.'),
    reason: z.string().trim().min(1).max(500, 'Reason can be up to 500 characters.').optional(),
  })
  .strict()

export const DROPDOWN_FIELDS = ['id', 'name', 'slug', 'category', 'parentSubjectId', 'minClassOrder', 'maxClassOrder', 'isTrending', 'sortOrder'] as const
export type DropdownField = (typeof DROPDOWN_FIELDS)[number]

export const listQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam,
  q: searchParam,
  active: boolParam.optional(),
  trending: boolParam.optional(),
  category: category.optional(),
  parentId: uuidParam.optional(),
  classId: uuidParam.optional(),
  includeDeleted: boolParam.optional(),
  sort: sortParam(['name', 'sortOrder', 'createdAt']),
  fields: fieldsParam(DROPDOWN_FIELDS),
})

export type CreateSubjectInput = z.infer<typeof createSubjectSchema>
export type PatchSubjectInput = z.infer<typeof patchSubjectSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
