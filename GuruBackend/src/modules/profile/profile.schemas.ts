import { z } from 'zod'

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

const ZONES = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC'])

const fullName = z.string().transform(collapse).pipe(z.string().min(2, 'Name must be 2–100 characters.').max(100, 'Name must be 2–100 characters.'))
const displayName = z.string().transform(collapse).pipe(z.string().min(2, 'Display name must be 2–40 characters.').max(40, 'Display name must be 2–40 characters.'))
const designation = z.string().transform(collapse).pipe(z.string().max(80, 'Designation can be up to 80 characters.'))
const phone = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Enter a phone number like +919876543210.')
const timezone = z.string().trim().refine((v) => ZONES.has(v), 'Pick a time zone from the list.')
const locale = z.enum(['en-IN', 'hi-IN'], { errorMap: () => ({ message: 'Choose English or Hindi.' }) })
const theme = z.enum(['light', 'dark', 'system'], { errorMap: () => ({ message: 'Choose light, dark or system.' }) })
const flag = z.boolean({ invalid_type_error: 'Choose on or off.' })

// FR-3.2. `null` clears an optional field; fields left out are untouched. security_alerts is always on, so it is
// not accepted here (the strict object rejects it).
export const patchProfileSchema = z
  .object({
    fullName: fullName.optional(),
    displayName: displayName.nullable().optional(),
    designation: designation.nullable().optional(),
    phone: phone.nullable().optional(),
    timezone: timezone.optional(),
    locale: locale.optional(),
    theme: theme.optional(),
    notificationPrefs: z.object({ email_digest: flag.optional(), queue_alerts: flag.optional() }).strict().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.')

export type PatchProfileInput = z.infer<typeof patchProfileSchema>

export const avatarSchema = z.object({ fileId: z.string().uuid('Upload a JPG, PNG or WebP image.') }).strict()

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(256),
    newPassword: z.string().min(1, 'Enter a new password.').max(256),
    signOutOtherSessions: z.boolean().default(true),
  })
  .strict()
