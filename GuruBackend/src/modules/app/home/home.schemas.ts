import { z } from 'zod'
import { RAIL_CODES } from './home.rails.js'

export const homeQuerySchema = z.object({
  childId: z.string().uuid().optional(),
  rail: z.enum(RAIL_CODES).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
})

export type HomeQuery = z.infer<typeof homeQuerySchema>
