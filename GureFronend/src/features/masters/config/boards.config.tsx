import { z } from 'zod'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type Board = MasterRow & {
  shortName: string
  type: string
  state: { id: string; name: string } | null
  stateId: string | null
  sortOrder: number
  usageCount: number
}

export const BOARD_TYPE_LABELS: Record<string, string> = {
  national: 'National',
  state: 'State board',
  international: 'International',
  university: 'University',
  other: 'Other',
}
const TYPE_OPTIONS: SelectOption[] = Object.entries(BOARD_TYPE_LABELS).map(([value, label]) => ({ value, label }))

// Mirrors the API rules in modules/M13 section 5: a state board needs a state, every other board has none.
export const boardFormSchema = z
  .object({
    name: z.string().trim().min(3, 'Full name must be 3–120 characters.').max(120, 'Full name must be 3–120 characters.'),
    shortName: z.string().trim().min(2, 'Short name must be 2–40 characters.').max(40, 'Short name must be 2–40 characters.'),
    type: z.string().refine((v) => v in BOARD_TYPE_LABELS, 'Pick a value from the list.'),
    stateId: z.string(),
    sortOrder: z
      .number({ error: 'Order must be a number.' })
      .int('Order must be a whole number.')
      .min(0, 'Order must be 0–9,999.')
      .max(9999, 'Order must be 0–9,999.'),
    isActive: z.boolean(),
  })
  .refine((v) => v.type !== 'state' || v.stateId !== '', { path: ['stateId'], message: 'Pick the state for a state board.' })
export type BoardForm = z.infer<typeof boardFormSchema>

export const boardsConfig: MasterConfig<Board, BoardForm> = {
  key: 'boards',
  singular: 'board',
  plural: 'boards',
  title: 'Boards',
  description: 'Education boards and curricula. National and international boards show everywhere; a state board only shows to users in its state.',
  apiPath: '/boards',
  readPermission: 'education_masters.read',
  managePermission: 'education_masters.manage',
  searchPlaceholder: 'Search by name or short name',
  fields: [
    { name: 'name', label: 'Full name', kind: 'text', placeholder: 'Kerala Board of Public Examinations', maxLength: 120 },
    { name: 'shortName', label: 'Short name', kind: 'text', placeholder: 'Kerala State Board', maxLength: 40, hint: 'Shown in chips in the app; must be unique' },
    { name: 'type', label: 'Type', kind: 'select', options: TYPE_OPTIONS },
    { name: 'stateId', label: 'State', kind: 'select', optionsFrom: '/states', showWhen: { field: 'type', equals: 'state' }, hint: 'Only active states can be picked' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive boards are hidden in the app' },
  ],
  schema: boardFormSchema,
  defaultValues: { name: '', shortName: '', type: '', stateId: '', sortOrder: 0, isActive: true },
  toFormValues: (b) => ({ name: b.name, shortName: b.shortName, type: b.type, stateId: b.stateId ?? '', sortOrder: b.sortOrder, isActive: b.isActive }),
  toPayload: (v) => ({
    name: v.name.trim(),
    shortName: v.shortName.trim(),
    type: v.type,
    stateId: v.type === 'state' ? v.stateId : null,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    {
      id: 'name',
      header: 'Board',
      sortKey: 'name',
      cell: (b) => (
        <span className="flex flex-col">
          <span className="font-medium">{b.shortName}</span>
          <span className="line-clamp-1 max-w-sm text-xs text-[var(--color-fg-muted)]">{b.name}</span>
        </span>
      ),
    },
    { id: 'type', header: 'Type', cell: (b) => BOARD_TYPE_LABELS[b.type] ?? b.type },
    { id: 'state', header: 'State', cell: (b) => b.state?.name ?? '—' },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (b) => b.sortOrder },
  ],
  filters: [
    { param: 'type', label: 'Type', allLabel: 'All types', options: TYPE_OPTIONS },
    { param: 'stateId', label: 'State', allLabel: 'All states', optionsFrom: '/states' },
  ],
  usage: (b) => ({ count: b.usageCount, label: b.usageCount === 0 ? 'Unused' : countLabel(b.usageCount, 'record') }),
  referenceNames: { teacher_classes: 'teacher class mappings', parent_children: 'children', students: 'students' },
  selectedOption: (b, field) => (field === 'stateId' && b.state ? { value: b.state.id, label: b.state.name } : null),
}
