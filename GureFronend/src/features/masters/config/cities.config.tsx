import { z } from 'zod'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { apiFetch } from '../../../lib/api'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type City = MasterRow & {
  state: { id: string; name: string }
  stateId: string
  slug: string
  latitude: number | null
  longitude: number | null
  tier: number | null
  isServiceable: boolean
  sortOrder: number
  areaCount: number
  verifiedTeachers: number
}

const TIER_OPTIONS: SelectOption[] = [
  { value: '1', label: 'Tier 1' },
  { value: '2', label: 'Tier 2' },
  { value: '3', label: 'Tier 3' },
]
const YES_NO: SelectOption[] = [
  { value: 'true', label: 'Launch cities' },
  { value: 'false', label: 'Not launched' },
]

// Coordinates are typed as text so an empty box means "none" instead of NaN; they are checked and converted here.
const coordinate = (label: string, limit: number) =>
  z.string().refine((v) => {
    if (v.trim() === '') return true
    const n = Number(v)
    return Number.isFinite(n) && Math.abs(n) <= limit
  }, `${label} must be a number between -${limit} and ${limit}.`)
const toNumber = (v: string) => (v.trim() === '' ? null : Number(v))

// Mirrors the API rules in modules/M09 section 5. The slug may be left blank on a new city: the API makes one.
export const cityFormSchema = z.object({
  stateId: z.string().min(1, 'Pick an active parent record.'),
  name: z.string().trim().min(2, 'City name must be 2–60 characters.').max(60, 'City name must be 2–60 characters.'),
  slug: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9-]{2,60}$/.test(v), 'Slug uses 2–60 letters, digits or hyphens.'),
  latitude: coordinate('Latitude', 90),
  longitude: coordinate('Longitude', 180),
  tier: z.string().refine((v) => v === '' || ['1', '2', '3'].includes(v), 'Tier is 1, 2 or 3.'),
  isServiceable: z.boolean(),
  sortOrder: z
    .number({ error: 'Order must be a number.' })
    .int('Order must be a whole number.')
    .min(0, 'Order must be 0–9,999.')
    .max(9999, 'Order must be 0–9,999.'),
  isActive: z.boolean(),
})
export type CityForm = z.infer<typeof cityFormSchema>

type Stats = { verifiedTeachers: number; institutes: number; parents: number; students: number; areas: number }

// FR-9.S1: launching a city asks first, with the counts that make it worth launching. Fewer than 20 verified teachers
// is a warning, not a block.
async function launchMessage(name: string, id: string | null): Promise<string> {
  const stats: Stats = id ? await apiFetch<Stats>(`/cities/${id}/stats`) : { verifiedTeachers: 0, institutes: 0, parents: 0, students: 0, areas: 0 }
  const counts = `${name} has ${countLabel(stats.verifiedTeachers, 'verified teacher')}, ${countLabel(stats.institutes, 'institute')} and ${countLabel(stats.areas, 'area')}.`
  const warning = stats.verifiedTeachers < 20 ? ' That is fewer than 20 verified teachers, so parents may find few results.' : ''
  return `${counts}${warning} It will show as a launch city in search, and its slug can’t change afterwards. Continue?`
}

export const citiesConfig: MasterConfig<City, CityForm> = {
  key: 'cities',
  singular: 'city',
  plural: 'cities',
  title: 'Cities',
  description: 'Cities under each state, with map position and market tier. A city only shows as a launch city in search once it is marked serviceable.',
  apiPath: '/cities',
  readPermission: 'locations.read',
  managePermission: 'locations.manage',
  searchPlaceholder: 'Search by name or slug',
  fields: [
    { name: 'stateId', label: 'State', kind: 'select', optionsFrom: '/states', hint: 'Only active states can be picked' },
    { name: 'name', label: 'City name', kind: 'text', placeholder: 'Kochi', maxLength: 60 },
    {
      name: 'slug',
      label: 'Slug',
      kind: 'text',
      placeholder: 'kochi',
      maxLength: 60,
      hint: 'Used in links and SEO pages. Leave blank to make it from the name.',
      lockedHint: 'A launch city’s slug can’t change, because links and SEO pages use it.',
    },
    { name: 'latitude', label: 'Latitude', kind: 'text', placeholder: '9.931233', hint: 'City centre, up to 6 decimals (optional)' },
    { name: 'longitude', label: 'Longitude', kind: 'text', placeholder: '76.267304', hint: 'City centre, up to 6 decimals (optional)' },
    { name: 'tier', label: 'Market tier', kind: 'select', options: TIER_OPTIONS, hint: 'Used for pricing and featured slots (optional)' },
    { name: 'isServiceable', label: 'Launch city', kind: 'switch', hint: 'Shown as a launch city in search. You will see the city’s numbers before it goes live.' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive cities are hidden everywhere' },
  ],
  schema: cityFormSchema,
  defaultValues: { stateId: '', name: '', slug: '', latitude: '', longitude: '', tier: '', isServiceable: false, sortOrder: 0, isActive: true },
  toFormValues: (c) => ({
    stateId: c.stateId,
    name: c.name,
    slug: c.slug,
    latitude: c.latitude === null ? '' : String(c.latitude),
    longitude: c.longitude === null ? '' : String(c.longitude),
    tier: c.tier === null ? '' : String(c.tier),
    isServiceable: c.isServiceable,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
  }),
  toPayload: (v) => ({
    stateId: v.stateId,
    name: v.name.trim(),
    ...(v.slug.trim() ? { slug: v.slug.trim().toLowerCase() } : {}),
    latitude: toNumber(v.latitude),
    longitude: toNumber(v.longitude),
    tier: v.tier === '' ? null : Number(v.tier),
    isServiceable: v.isServiceable,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    {
      id: 'name',
      header: 'City',
      sortKey: 'name',
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-medium">{c.name}</span>
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{c.slug}</span>
        </span>
      ),
    },
    { id: 'state', header: 'State', cell: (c) => c.state.name },
    { id: 'tier', header: 'Tier', cell: (c) => (c.tier ? `Tier ${c.tier}` : '—') },
    { id: 'launch', header: 'Launch', cell: (c) => (c.isServiceable ? <StatusBadge tone="good">Launch city</StatusBadge> : <StatusBadge>Not launched</StatusBadge>) },
    { id: 'teachers', header: 'Verified teachers', align: 'right', cell: (c) => c.verifiedTeachers },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (c) => c.sortOrder },
  ],
  filters: [
    { param: 'countryId', label: 'Country', allLabel: 'All countries', optionsFrom: '/countries' },
    { param: 'stateId', label: 'State', allLabel: 'All states', optionsFrom: '/states' },
    { param: 'tier', label: 'Tier', allLabel: 'Any tier', options: TIER_OPTIONS },
    { param: 'serviceable', label: 'Launch', allLabel: 'All', options: YES_NO },
  ],
  usage: (c) => ({ count: c.areaCount, label: c.areaCount === 0 ? 'Unused' : countLabel(c.areaCount, 'area') }),
  referenceNames: { areas: 'areas', teacher_locations: 'teacher locations', institutes: 'institutes', parents: 'parents', students: 'students' },
  selectedOption: (c, field) => (field === 'stateId' ? { value: c.state.id, label: c.state.name } : null),
  // FR-9.S2: the slug is frozen once the city is live.
  rowRules: { lockedFields: (c) => (c.isServiceable ? ['slug'] : []) },
  confirmSave: async ({ row, payload }) => {
    if (payload.isServiceable !== true || row?.isServiceable) return null
    return launchMessage(String(payload.name ?? row?.name ?? 'This city'), row?.id ?? null)
  },
}
