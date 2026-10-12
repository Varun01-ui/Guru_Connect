import type { Audience, Banner, BannerInput, Placement } from './api/banners.api'

export type FormValues = {
  title: string
  subtitle: string
  imageFileId: string
  imageUrl: string | null
  placement: Placement
  audience: Audience
  cityIds: string[]
  deepLink: string | null
  priority: number
  startsAt: string // datetime-local, e.g. 2027-01-01T09:00
  endsAt: string // '' = until paused
}

const pad = (n: number) => String(n).padStart(2, '0')

// <input type="datetime-local"> works in local time without a zone; the API wants an instant.
export function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = (value: string): string => new Date(value).toISOString()

export const emptyForm = (): FormValues => {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  return {
    title: '',
    subtitle: '',
    imageFileId: '',
    imageUrl: null,
    placement: 'home_top',
    audience: 'all',
    cityIds: [],
    deepLink: null,
    priority: 0,
    startsAt: toLocalInput(start.toISOString()),
    endsAt: '',
  }
}

export const formFromBanner = (b: Banner): FormValues => ({
  title: b.title,
  subtitle: b.subtitle ?? '',
  imageFileId: b.image.fileId,
  imageUrl: b.image.url,
  placement: b.placement,
  audience: b.audience,
  cityIds: b.cities.map((c) => c.id),
  deepLink: b.deepLink,
  priority: b.priority,
  startsAt: toLocalInput(b.startsAt),
  endsAt: toLocalInput(b.endsAt),
})

export function payloadOf(v: FormValues): BannerInput {
  return {
    title: v.title.trim().replace(/\s+/g, ' '),
    subtitle: v.subtitle.trim() === '' ? null : v.subtitle.trim().replace(/\s+/g, ' '),
    imageFileId: v.imageFileId,
    placement: v.placement,
    audience: v.audience,
    cityIds: v.cityIds,
    deepLink: v.deepLink,
    priority: v.priority,
    startsAt: fromLocalInput(v.startsAt),
    endsAt: v.endsAt ? fromLocalInput(v.endsAt) : null,
  }
}

// Only the fields that differ from what was loaded, so an edit sends (and audits) just what changed.
export function changesOf(now: FormValues, was: FormValues): Partial<BannerInput> {
  const next = payloadOf(now)
  const prev = payloadOf(was)
  return Object.fromEntries((Object.keys(next) as (keyof BannerInput)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k])).map((k) => [k, next[k]]))
}

const DAY = 86_400_000
export function validateForm(v: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  const title = v.title.trim().replace(/\s+/g, ' ')
  if (title.length < 3 || title.length > 60) errors.title = 'Title must be 3–60 characters.'
  if (v.subtitle.trim().length > 90) errors.subtitle = 'Subtitle can be up to 90 characters.'
  if (!v.imageFileId) errors.imageFileId = 'Upload the banner image.'
  if (v.cityIds.length > 50) errors.cityIds = 'Pick up to 50 cities.'
  if (!Number.isInteger(v.priority) || v.priority < 0 || v.priority > 100) errors.priority = 'Priority must be 0–100.'
  const start = new Date(v.startsAt)
  if (!v.startsAt || Number.isNaN(start.getTime())) errors.startsAt = 'Pick a start date and time.'
  if (v.endsAt) {
    const end = new Date(v.endsAt)
    if (Number.isNaN(end.getTime())) errors.endsAt = 'Pick an end date and time.'
    else if (!errors.startsAt && end <= start) errors.endsAt = 'The end must be after the start.'
    else if (!errors.startsAt && end.getTime() > start.getTime() + 180 * DAY) errors.endsAt = 'A banner can run for at most 180 days.'
  }
  return errors
}
