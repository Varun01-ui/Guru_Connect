import { z } from 'zod'

// Query-string and body building blocks shared by every master-data list (conventions section 4).
export const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true')
export const pageParam = z.coerce.number().int().min(1).default(1)
export const pageSizeParam = z.coerce.number().int().min(1).max(100).default(20)
export const searchParam = z.string().trim().min(1).max(100).optional()
export const uuidParam = z.string().uuid()

export function sortParam(keys: readonly string[]) {
  return z
    .string()
    .regex(new RegExp(`^(${keys.join('|')}):(asc|desc)$`), `Sort by ${keys.join(', ')}, e.g. ${keys[0]}:asc.`)
    .optional()
}

// `?fields=id,name` switches a list to dropdown mode: only these fields, active rows, no paging.
export function fieldsParam<T extends string>(allowed: readonly [T, ...T[]]) {
  return z
    .string()
    .transform((s) => s.split(',').map((f) => f.trim()).filter(Boolean))
    .pipe(z.array(z.enum(allowed, { errorMap: () => ({ message: 'Unknown field.' }) })).min(1))
    .optional()
}

export const reasonBodySchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().default({})

// PUT /<resource>/order. The full list of live ids in the new sequence.
export const orderBodySchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict()

/** `prefix%` pattern for LIKE with the user's wildcards made literal. */
export const likePrefix = (term: string) => `${term.replace(/[\\%_]/g, '\\$&')}%`

export const collapseSpaces = (s: string) => s.trim().replace(/\s+/g, ' ')
export const upperCase = (s: string) => s.trim().toUpperCase()

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}
