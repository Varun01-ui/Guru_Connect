import { z } from 'zod'
import type { MasterConfig, MasterRow } from '../types'
import { countLabel } from './labels'

export type Country = MasterRow & {
  sortOrder: number
  iso2: string
  iso3: string
  phoneCode: string
  currencyCode: string
  stateCount: number
}

// Mirrors the API rules in modules/M07 section 5. Codes are accepted in any case and sent upper-cased.
export const countryFormSchema = z.object({
  name: z.string().trim().min(2, 'Country name must be 2–60 characters.').max(60, 'Country name must be 2–60 characters.'),
  iso2: z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO alpha-2 must be exactly 2 letters.'),
  iso3: z.string().trim().regex(/^[A-Za-z]{3}$/, 'ISO alpha-3 must be exactly 3 letters.'),
  phoneCode: z.string().trim().regex(/^\+\d{1,4}$/, 'Dialling code looks like +91.'),
  currencyCode: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter ISO 4217 code, e.g. INR.'),
  sortOrder: z
    .number({ error: 'Order must be a number.' })
    .int('Order must be a whole number.')
    .min(0, 'Order must be 0–9,999.')
    .max(9999, 'Order must be 0–9,999.'),
  isActive: z.boolean(),
})
export type CountryForm = z.infer<typeof countryFormSchema>

export const countriesConfig: MasterConfig<Country, CountryForm> = {
  key: 'countries',
  singular: 'country',
  plural: 'countries',
  title: 'Countries',
  description: 'Countries GuruConnect can operate in. Inactive countries stay on existing records but are hidden from the app.',
  apiPath: '/countries',
  readPermission: 'locations.read',
  managePermission: 'locations.manage',
  searchPlaceholder: 'Search by name or ISO code',
  fields: [
    { name: 'name', label: 'Country name', kind: 'text', placeholder: 'United Arab Emirates', maxLength: 60 },
    { name: 'iso2', label: 'ISO alpha-2', kind: 'text', placeholder: 'AE', maxLength: 2, hint: 'Two letters, e.g. IN' },
    { name: 'iso3', label: 'ISO alpha-3', kind: 'text', placeholder: 'ARE', maxLength: 3, hint: 'Three letters, e.g. IND' },
    { name: 'phoneCode', label: 'Dialling code', kind: 'text', placeholder: '+971', maxLength: 5 },
    { name: 'currencyCode', label: 'Currency', kind: 'text', placeholder: 'AED', maxLength: 3, hint: 'ISO 4217, e.g. INR' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first in dropdowns (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive countries are hidden in the app' },
  ],
  schema: countryFormSchema,
  defaultValues: { name: '', iso2: '', iso3: '', phoneCode: '', currencyCode: '', sortOrder: 0, isActive: true },
  toFormValues: (c) => ({
    name: c.name,
    iso2: c.iso2,
    iso3: c.iso3,
    phoneCode: c.phoneCode,
    currencyCode: c.currencyCode,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
  }),
  toPayload: (v) => ({
    name: v.name.trim(),
    iso2: v.iso2.trim().toUpperCase(),
    iso3: v.iso3.trim().toUpperCase(),
    phoneCode: v.phoneCode.trim(),
    currencyCode: v.currencyCode.trim().toUpperCase(),
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    { id: 'name', header: 'Country', sortKey: 'name', cell: (c) => <span className="font-medium">{c.name}</span> },
    {
      id: 'codes',
      header: 'ISO',
      cell: (c) => (
        <span className="font-mono text-xs">
          {c.iso2} · {c.iso3}
        </span>
      ),
    },
    { id: 'phone', header: 'Dial code', cell: (c) => c.phoneCode },
    { id: 'currency', header: 'Currency', cell: (c) => c.currencyCode },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (c) => c.sortOrder },
  ],
  usage: (c) => ({ count: c.stateCount, label: c.stateCount === 0 ? 'Unused' : countLabel(c.stateCount, 'state') }),
  referenceNames: { states: 'states' },
}
