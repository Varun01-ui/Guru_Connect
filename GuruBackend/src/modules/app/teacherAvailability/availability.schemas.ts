import { z } from 'zod'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const time = z.string().regex(HHMM, 'Use HH:mm.')

export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

const windowSchema = z
  .object({
    // 0 = Sunday ... 6 = Saturday (the API's convention); stored as ISO 1..7 (Sunday = 7).
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: time,
    endTime: time,
    teachingModeId: z.string().uuid().nullish(),
    acceptsDemos: z.boolean().default(true),
  })
  .refine((w) => minutesOf(w.endTime) > minutesOf(w.startTime), { path: ['endTime'], message: 'End time must be after start time' })
  .refine((w) => minutesOf(w.endTime) - minutesOf(w.startTime) >= 30, { path: ['endTime'], message: 'End time must be after start time' })

export const setAvailabilitySchema = z.object({ items: z.array(windowSchema).max(35) })

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a range up to 90 days')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Pick a range up to 90 days')

export const createTimeOffSchema = z.object({
  startsOn: isoDate,
  endsOn: isoDate,
  reason: z.string().trim().max(200).nullish(),
  pauseLeads: z.boolean(),
  confirmForce: z.boolean().default(false),
})

export const idParamSchema = z.object({ id: z.string().uuid() })
