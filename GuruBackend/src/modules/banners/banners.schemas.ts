import { z } from 'zod'

export const PLACEMENTS = ['home_top', 'home_middle', 'search_inline', 'teacher_dashboard', 'institute_dashboard', 'onboarding'] as const
export const AUDIENCES = ['all', 'parents', 'students', 'teachers', 'institutes'] as const
export const STATUSES = ['draft', 'scheduled', 'active', 'paused', 'expired'] as const

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')
const DAY_MS = 86_400_000

const title = z.string().transform(collapse).pipe(z.string().min(3, 'Title must be 3–60 characters.').max(60, 'Title must be 3–60 characters.'))
const subtitle = z.string().transform(collapse).pipe(z.string().max(90, 'Subtitle can be up to 90 characters.'))
const uuid = (message: string) => z.string({ required_error: message, invalid_type_error: message }).uuid(message)
const placement = z.enum(PLACEMENTS, { errorMap: () => ({ message: 'Choose where the banner shows.' }) })
const audience = z.enum(AUDIENCES, { errorMap: () => ({ message: 'Choose who sees the banner.' }) })
const cityIds = z
  .array(uuid('Pick cities from the list.'))
  .max(50, 'Pick up to 50 cities.')
  .transform((ids) => [...new Set(ids)])
const deepLink = z.string().trim().min(1).max(500, 'Use an app link or an approved website.')
const priority = z.number({ invalid_type_error: 'Priority must be 0–100.' }).int('Priority must be 0–100.').min(0, 'Priority must be 0–100.').max(100, 'Priority must be 0–100.')
const instant = (message: string) => z.string({ required_error: message, invalid_type_error: message }).datetime({ offset: true, message })

const base = {
  title,
  subtitle: subtitle.nullable(),
  imageFileId: uuid('Upload the banner image.'),
  placement,
  audience,
  cityIds,
  deepLink: deepLink.nullable(),
  priority,
  startsAt: instant('Pick a start date and time.'),
  endsAt: instant('Pick an end date and time.').nullable(),
}

export const createBannerSchema = z
  .object({
    title: base.title,
    subtitle: base.subtitle.optional(),
    imageFileId: base.imageFileId,
    placement: base.placement,
    audience: base.audience.default('all'),
    cityIds: base.cityIds.default([]),
    deepLink: base.deepLink.optional(),
    priority: base.priority.default(0),
    startsAt: base.startsAt,
    endsAt: base.endsAt.optional(),
  })
  .strict()

export const patchBannerSchema = z
  .object({
    title: base.title.optional(),
    subtitle: base.subtitle.optional(),
    imageFileId: base.imageFileId.optional(),
    placement: base.placement.optional(),
    audience: base.audience.optional(),
    cityIds: base.cityIds.optional(),
    deepLink: base.deepLink.optional(),
    priority: base.priority.optional(),
    startsAt: base.startsAt.optional(),
    endsAt: base.endsAt.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export type CreateBannerInput = z.infer<typeof createBannerSchema>
export type PatchBannerInput = z.infer<typeof patchBannerSchema>

// FR-44.1: the end must follow the start, by at most 180 days.
export function windowIssue(startsAt: Date, endsAt: Date | null): string | null {
  if (!endsAt) return null
  if (endsAt <= startsAt) return 'The end must be after the start.'
  if (endsAt.getTime() > startsAt.getTime() + 180 * DAY_MS) return 'A banner can run for at most 180 days.'
  return null
}

export const reorderSchema = z
  .object({
    placement,
    ids: z
      .array(uuid('Invalid banner id.'))
      .min(1, 'Pick at least one banner.')
      .max(100, 'Reorder up to 100 banners at a time.')
      .refine((ids) => new Set(ids).size === ids.length, 'Each banner can appear once.'),
  })
  .strict()

const bool = z.enum(['true', 'false']).transform((v) => v === 'true')

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().min(1).max(100).optional(),
  placement: placement.optional(),
  status: z.enum(STATUSES).optional(),
  audience: audience.optional(),
  cityId: z.string().uuid().optional(),
  activeOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-01-15.').optional(),
  includeDeleted: bool.optional(),
  sort: z
    .string()
    .regex(/^(priority|startsAt|ctr):(asc|desc)$/, 'Sort by priority, startsAt or ctr, e.g. priority:desc.')
    .optional(),
})
export type ListQuery = z.infer<typeof listQuerySchema>

export const previewQuerySchema = z.object({
  audience: z.enum(['parents', 'students', 'teachers', 'institutes']).default('parents'),
  cityId: z.string().uuid().optional(),
})
export type PreviewQuery = z.infer<typeof previewQuerySchema>

// ---- mobile ----

export const servingQuerySchema = z.object({
  placement,
  cityId: z.string().uuid().optional(),
  audience: z.enum(['parents', 'students', 'teachers', 'institutes']).optional(),
})

export const eventsSchema = z
  .object({
    events: z
      .array(
        z.object({
          bannerId: z.string().uuid(),
          type: z.enum(['impression', 'click']),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict()
