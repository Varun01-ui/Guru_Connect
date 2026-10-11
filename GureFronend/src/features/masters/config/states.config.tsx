import { z } from 'zod'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type StateRow = MasterRow & {
  country: { id: string; name: string }
  countryId: string
  code: string
  type: 'state' | 'union_territory'
  sortOrder: number
  cityCount: number
}

const TYPE_OPTIONS: SelectOption[] = [
  { value: 'state', label: 'State' },
  { value: 'union_territory', label: 'Union territory' },
]

// Mirrors the API rules in modules/M08 section 5. The code is accepted in any case and sent upper-cased.
export const stateFormSchema = z.object({
  countryId: z.string().min(1, 'Pick an active parent record.'),
  name: z.string().trim().min(2, 'State name must be 2–60 characters.').max(60, 'State name must be 2–60 characters.'),
  code: z.string().trim().regex(/^[A-Za-z0-9]{1,5}$/, 'Code uses 1–5 letters or digits.'),
  type: z.enum(['state', 'union_territory'], { error: 'Pick a value from the list.' }),
  sortOrder: z
    .number({ error: 'Order must be a number.' })
    .int('Order must be a whole number.')
    .min(0, 'Order must be 0–9,999.')
    .max(9999, 'Order must be 0–9,999.'),
  isActive: z.boolean(),
})
export type StateForm = z.infer<typeof stateFormSchema>

export const statesConfig: MasterConfig<StateRow, StateForm> = {
  key: 'states',
  singular: 'state',
  plural: 'states',
  title: 'States',
  description: 'States and union territories under each country. They are used in addresses, to pick the state education board, and in regional reports.',
  apiPath: '/states',
  readPermission: 'locations.read',
  managePermission: 'locations.manage',
  searchPlaceholder: 'Search by name or code',
  fields: [
    {
      name: 'countryId',
      label: 'Country',
      kind: 'select',
      optionsFrom: '/countries',
      hint: 'Only active countries can be picked',
      lockedHint: 'This state has cities, so it can’t move to another country. Create a new state instead.',
    },
    { name: 'name', label: 'State name', kind: 'text', placeholder: 'Kerala', maxLength: 60 },
    { name: 'code', label: 'Code', kind: 'text', placeholder: 'KL', maxLength: 5, hint: '1–5 letters or digits, unique within the country (e.g. the ISO 3166-2 suffix)' },
    { name: 'type', label: 'Type', kind: 'select', options: TYPE_OPTIONS },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive states are hidden in the app' },
  ],
  schema: stateFormSchema,
  defaultValues: { countryId: '', name: '', code: '', type: 'state', sortOrder: 0, isActive: true },
  toFormValues: (s) => ({ countryId: s.countryId, name: s.name, code: s.code, type: s.type, sortOrder: s.sortOrder, isActive: s.isActive }),
  toPayload: (v) => ({ countryId: v.countryId, name: v.name.trim(), code: v.code.trim().toUpperCase(), type: v.type, sortOrder: v.sortOrder, isActive: v.isActive }),
  columns: [
    {
      id: 'name',
      header: 'State',
      sortKey: 'name',
      cell: (s) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{s.name}</span>
          {s.type === 'union_territory' ? <StatusBadge tone="info">Union territory</StatusBadge> : null}
        </span>
      ),
    },
    { id: 'country', header: 'Country', cell: (s) => s.country.name },
    { id: 'code', header: 'Code', cell: (s) => <span className="font-mono text-xs">{s.code}</span> },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (s) => s.sortOrder },
  ],
  filters: [
    { param: 'countryId', label: 'Country', allLabel: 'All countries', optionsFrom: '/countries' },
    { param: 'type', label: 'Type', allLabel: 'All types', options: TYPE_OPTIONS },
  ],
  usage: (s) => ({ count: s.cityCount, label: s.cityCount === 0 ? 'Unused' : countLabel(s.cityCount, 'city', 'cities') }),
  referenceNames: { cities: 'cities', boards: 'state boards', parents: 'parents' },
  selectedOption: (s, field) => (field === 'countryId' ? { value: s.country.id, label: s.country.name } : null),
  // FR-8.S1: the API refuses to move a state that has cities; the form just doesn't offer it.
  rowRules: { lockedFields: (s) => (s.cityCount > 0 ? ['countryId'] : []) },
  importCsv: {
    columns: 'country_iso2,name,code,type',
    example: 'country_iso2,name,code,type\nIN,Kerala,KL,state\nIN,Ladakh,LA,union_territory',
  },
}
