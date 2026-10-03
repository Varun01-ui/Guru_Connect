import { z } from 'zod'

const fullName = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(2, 'Enter your full name.')
      .max(100, 'Enter your full name.')
      .regex(/^[\p{L}\p{M}][\p{L}\p{M} .-]*$/u, 'Enter your full name.'),
  )

// areaId may be null to clear the area explicitly; cityId cannot be cleared (a parent always has a city).
export const updateProfileSchema = z
  .object({
    fullName,
    cityId: z.string().uuid('Choose a city.'),
    areaId: z.string().uuid().nullable(),
    // A file from POST /uploads (purpose 'avatar'), or null to remove the photo and fall back to initials.
    profilePhotoFileId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.')

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>
