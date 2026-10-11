import { z } from 'zod'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import type { MasterConfig, MasterRow } from '../types'
import { countLabel } from './labels'

export type TeachingMode = MasterRow & {
  code: string
  description: string | null
  requiresLocation: boolean
  sortOrder: number
  isSystem: boolean
  teacherCount: number
}

// Mirrors the API rules in modules/M14 section 5. The code is accepted in any case and sent upper-cased; a blank
// description is sent as null.
export const teachingModeFormSchema = z.object({
  name: z.string().trim().min(2, 'Name must be 2–40 characters.').max(40, 'Name must be 2–40 characters.'),
  code: z.string().trim().regex(/^[A-Za-z_]{3,30}$/, 'Code uses 3–30 letters or underscores.'),
  description: z.string().trim().max(200, 'Description can be up to 200 characters.'),
  requiresLocation: z.boolean(),
  sortOrder: z
    .number({ error: 'Order must be a number.' })
    .int('Order must be a whole number.')
    .min(0, 'Order must be 0–9,999.')
    .max(9999, 'Order must be 0–9,999.'),
  isActive: z.boolean(),
})
export type TeachingModeForm = z.infer<typeof teachingModeFormSchema>

export const teachingModesConfig: MasterConfig<TeachingMode, TeachingModeForm> = {
  key: 'teaching-modes',
  singular: 'teaching mode',
  plural: 'teaching modes',
  title: 'Teaching modes',
  description: 'How classes are delivered. The five built-in modes are used by the apps, so they can be renamed and re-ordered but not removed.',
  apiPath: '/teaching-modes',
  readPermission: 'education_masters.read',
  managePermission: 'education_masters.manage',
  searchPlaceholder: 'Search by name or code',
  fields: [
    { name: 'name', label: 'Name', kind: 'text', placeholder: 'Recorded course', maxLength: 40 },
    { name: 'code', label: 'Code', kind: 'text', placeholder: 'RECORDED', maxLength: 30, hint: 'Capital letters and underscores. The apps use it, so it can’t change later.', immutable: true },
    { name: 'description', label: 'Description', kind: 'textarea', placeholder: 'Pre-recorded lessons with weekly doubt calls', maxLength: 200, hint: 'Shown to teachers as help text (optional)' },
    { name: 'requiresLocation', label: 'Needs location', kind: 'switch', hint: 'Turn off for online-only modes: the app then won’t ask for a city or area' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive modes are hidden in the app' },
  ],
  schema: teachingModeFormSchema,
  defaultValues: { name: '', code: '', description: '', requiresLocation: true, sortOrder: 0, isActive: true },
  toFormValues: (m) => ({
    name: m.name,
    code: m.code,
    description: m.description ?? '',
    requiresLocation: m.requiresLocation,
    sortOrder: m.sortOrder,
    isActive: m.isActive,
  }),
  toPayload: (v) => ({
    name: v.name.trim(),
    code: v.code.trim().toUpperCase(),
    description: v.description.trim() === '' ? null : v.description.trim(),
    requiresLocation: v.requiresLocation,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    {
      id: 'name',
      header: 'Mode',
      sortKey: 'name',
      cell: (m) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{m.name}</span>
          {m.isSystem ? <StatusBadge tone="info">Built-in</StatusBadge> : null}
        </span>
      ),
    },
    { id: 'code', header: 'Code', cell: (m) => <span className="font-mono text-xs">{m.code}</span> },
    { id: 'description', header: 'Description', cell: (m) => <span className="line-clamp-1 max-w-xs text-[var(--color-fg-muted)]">{m.description ?? '—'}</span> },
    { id: 'location', header: 'Needs location', cell: (m) => (m.requiresLocation ? 'Yes' : 'No') },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (m) => m.sortOrder },
  ],
  usage: (m) => ({ count: m.teacherCount, label: m.teacherCount === 0 ? 'Unused' : countLabel(m.teacherCount, 'teacher') }),
  referenceNames: {
    teacher_teaching_modes: 'teachers',
    parent_children: 'children',
    institute_batches: 'institute batches',
    demo_requests: 'demo requests',
  },
  // FR-14.S1: built-in modes keep their flags and can't be removed; the API refuses these too.
  rowRules: {
    canToggle: (m) => !m.isSystem,
    canDelete: (m) => !m.isSystem,
    lockedFields: (m) => (m.isSystem ? ['requiresLocation', 'isActive'] : []),
  },
}
