import { z } from 'zod'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type Area = MasterRow & {
  city: { id: string; name: string }
  cityId: string
  slug: string
  pincodes: string[]
  latitude: number | null
  longitude: number | null
  sortOrder: number
  teacherCount: number
}

const COORDINATES: SelectOption[] = [
  { value: 'true', label: 'Has coordinates' },
  { value: 'false', label: 'No coordinates' },
]

const PIN = /^[1-9][0-9]{5}$/
const splitPins = (text: string) => text.split(/[\s,;|]+/).filter(Boolean)
const coordinate = (label: string, limit: number) =>
  z.string().refine((v) => {
    if (v.trim() === '') return true
    const n = Number(v)
    return Number.isFinite(n) && Math.abs(n) <= limit
  }, `${label} must be a number between -${limit} and ${limit}.`)
const toNumber = (v: string) => (v.trim() === '' ? null : Number(v))

// Mirrors the API rules in modules/M10 section 5. PIN codes are typed in one box, separated by commas or spaces.
export const areaFormSchema = z.object({
  cityId: z.string().min(1, 'Pick an active parent record.'),
  name: z.string().trim().min(2, 'Area name must be 2–80 characters.').max(80, 'Area name must be 2–80 characters.'),
  pincodes: z.string().superRefine((text, ctx) => {
    const pins = splitPins(text)
    if (pins.some((p) => !PIN.test(p))) ctx.addIssue({ code: 'custom', message: 'A PIN code is 6 digits and does not start with 0.' })
    else if (new Set(pins).size !== pins.length) ctx.addIssue({ code: 'custom', message: 'Each PIN code can only be listed once.' })
    else if (pins.length > 20) ctx.addIssue({ code: 'custom', message: 'An area can have up to 20 PIN codes.' })
  }),
  latitude: coordinate('Latitude', 90),
  longitude: coordinate('Longitude', 180),
  sortOrder: z
    .number({ error: 'Order must be a number.' })
    .int('Order must be a whole number.')
    .min(0, 'Order must be 0–9,999.')
    .max(9999, 'Order must be 0–9,999.'),
  isActive: z.boolean(),
})
export type AreaForm = z.infer<typeof areaFormSchema>

export const areasConfig: MasterConfig<Area, AreaForm> = {
  key: 'areas',
  singular: 'area',
  plural: 'areas',
  title: 'Areas',
  description: 'Localities within each city, with the PIN codes they cover. They power “nearby teachers”, teacher coverage and parent addresses.',
  apiPath: '/areas',
  readPermission: 'locations.read',
  managePermission: 'locations.manage',
  searchPlaceholder: 'Search by name or PIN code',
  fields: [
    { name: 'cityId', label: 'City', kind: 'select', optionsFrom: '/cities', hint: 'Only active cities can be picked' },
    { name: 'name', label: 'Area name', kind: 'text', placeholder: 'Koramangala', maxLength: 80 },
    { name: 'pincodes', label: 'PIN codes', kind: 'text', placeholder: '560034, 560095', hint: 'Up to 20, separated by commas or spaces' },
    { name: 'latitude', label: 'Latitude', kind: 'text', placeholder: '12.935242', hint: 'Area centre, up to 6 decimals (optional)' },
    { name: 'longitude', label: 'Longitude', kind: 'text', placeholder: '77.62448', hint: 'Area centre, up to 6 decimals (optional)' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive areas are hidden in the app' },
  ],
  schema: areaFormSchema,
  defaultValues: { cityId: '', name: '', pincodes: '', latitude: '', longitude: '', sortOrder: 0, isActive: true },
  toFormValues: (a) => ({
    cityId: a.cityId,
    name: a.name,
    pincodes: a.pincodes.join(', '),
    latitude: a.latitude === null ? '' : String(a.latitude),
    longitude: a.longitude === null ? '' : String(a.longitude),
    sortOrder: a.sortOrder,
    isActive: a.isActive,
  }),
  toPayload: (v) => ({
    cityId: v.cityId,
    name: v.name.trim(),
    pincodes: [...splitPins(v.pincodes)].sort(),
    latitude: toNumber(v.latitude),
    longitude: toNumber(v.longitude),
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    {
      id: 'name',
      header: 'Area',
      sortKey: 'name',
      cell: (a) => (
        <span className="flex flex-col">
          <span className="font-medium">{a.name}</span>
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{a.slug}</span>
        </span>
      ),
    },
    { id: 'city', header: 'City', cell: (a) => a.city.name },
    { id: 'pins', header: 'PIN codes', cell: (a) => <span className="font-mono text-xs">{a.pincodes.length === 0 ? '—' : a.pincodes.join(', ')}</span> },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (a) => a.sortOrder },
  ],
  filters: [
    { param: 'cityId', label: 'City', allLabel: 'All cities', optionsFrom: '/cities' },
    { param: 'hasCoordinates', label: 'Map position', allLabel: 'Any', options: COORDINATES },
  ],
  usage: (a) => ({ count: a.teacherCount, label: a.teacherCount === 0 ? 'Unused' : countLabel(a.teacherCount, 'teacher') }),
  referenceNames: { teacher_locations: 'teacher locations', institutes: 'institutes', parents: 'parents', students: 'students' },
  selectedOption: (a, field) => (field === 'cityId' ? { value: a.city.id, label: a.city.name } : null),
  importCsv: {
    columns: 'city_slug,name,pincodes,latitude,longitude',
    example: 'city_slug,name,pincodes,latitude,longitude\nbengaluru,Koramangala,560034 560095,12.935242,77.62448\nbengaluru,HSR Layout,560102,,',
    allowSkipInvalid: true,
  },
  // FR-10.S2: duplicates inside a city are folded together; areas of different cities can't be merged.
  merge: {
    targetKey: 'intoAreaId',
    scope: (a) => ({ cityId: a.cityId }),
    warning: 'Teachers, parents and students in this area move to the one you pick, their PIN codes are combined, and this area is removed.',
  },
}
