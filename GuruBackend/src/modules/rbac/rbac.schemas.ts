import { z } from 'zod'

const uuid = z.string().uuid()
const reason = z.string().trim().min(5, 'Add a reason (5–500 characters).').max(500, 'Add a reason (5–500 characters).')

export const roleNameSchema = z.string().trim().min(3, 'Role name must be 3–50 characters.').max(50, 'Role name must be 3–50 characters.')
const description = z.string().trim().max(250, 'Description can be up to 250 characters.')
const permissionKeys = z.array(z.string().trim().min(1).max(100)).max(200, 'A role can have up to 200 permissions.')

export const createRoleSchema = z
  .object({
    name: roleNameSchema,
    description: description.nullish(),
    copyFromRoleId: uuid.nullish(),
    permissionKeys: permissionKeys.nullish(),
    reason: reason.optional(),
  })
  .strict()

export const patchRoleSchema = z
  .object({ name: roleNameSchema, description: description.nullable() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.')

export const putRolePermissionsSchema = z.object({ permissionKeys, reason: reason.optional() }).strict()

export const idParamSchema = z.object({ id: z.string().uuid() })

const PAGE_SIZES = [10, 20, 50, 100] as const
const asArray = (v: unknown) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])

export const adminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'pageSize must be 10, 20, 50 or 100.')
    .default(20),
  status: z.preprocess(asArray, z.array(z.enum(['active', 'invited', 'locked', 'disabled'])).optional()),
  roleId: uuid.optional(),
  lastLogin: z.enum(['never', 'stale30']).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  sort: z.string().regex(/^[A-Za-z]+:(asc|desc)(,[A-Za-z]+:(asc|desc))*$/, 'Invalid sort.').optional(),
})

const personName = z
  .string()
  .trim()
  .min(2, 'Name must be 2–100 characters.')
  .max(100, 'Name must be 2–100 characters.')
  .regex(/^[\p{L}][\p{L} .'-]*$/u, 'Name can contain letters, spaces, . \' and -.')

const roleIds = z
  .array(uuid)
  .min(1, 'Choose 1–5 roles.')
  .max(5, 'Choose 1–5 roles.')
  .refine((a) => new Set(a).size === a.length, 'Each role can only be chosen once.')

export const inviteAdminSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254, 'Enter a valid email address.'),
    fullName: personName,
    roleIds,
    reason: reason.optional(),
  })
  .strict()

export const patchAdminSchema = z.object({ fullName: personName }).strict()
export const putAdminRolesSchema = z.object({ roleIds, reason: reason.optional() }).strict()
export const reasonBodySchema = z.object({ reason }).strict()
