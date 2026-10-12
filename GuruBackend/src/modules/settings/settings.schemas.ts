import { z } from 'zod'
import { GROUP_ORDER } from './settings.registry.js'

// Values are validated per key in the service (the type comes from the row), so the body only checks its shape.
export const patchSettingsSchema = z
  .object({
    group: z.string().trim().min(1, 'Choose a settings group.').max(40),
    values: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, 'Change at least one setting.'),
    reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
    confirmMaintenance: z.boolean().optional(),
  })
  .strict()

export type PatchSettingsInput = z.infer<typeof patchSettingsSchema>

export const settingKeySchema = z.string().trim().min(3).max(100).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'Unknown setting.')

export const KNOWN_GROUPS: readonly string[] = GROUP_ORDER
