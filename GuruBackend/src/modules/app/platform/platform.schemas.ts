import { z } from 'zod'

export const deviceBodySchema = z.object({
  installId: z.string().uuid(),
  platform: z.enum(['android', 'ios']),
  osVersion: z.string().optional(),
  appVersion: z.string().min(1),
  buildNumber: z.number().int().optional(),
  deviceModel: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
})

export const areasQuerySchema = z.object({
  cityId: z.string().uuid(),
})
