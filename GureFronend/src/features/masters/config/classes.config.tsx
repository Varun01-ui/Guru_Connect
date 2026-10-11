import { z } from 'zod'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type ClassRow = MasterRow & {
  code: string
  stage: string
  levelOrder: number
  teacherCount: number
  childCount: number
}

export const STAGE_LABELS: Record<string, string> = {
  pre_primary: 'Pre-primary',
  primary: 'Primary',
  middle: 'Middle',
  secondary: 'Secondary',
  senior_secondary: 'Senior secondary',
  undergraduate: 'Undergraduate',
  postgraduate: 'Postgraduate',
  competitive: 'Competitive exams',
  adult: 'Adult learners',
}
const STAGE_OPTIONS: SelectOption[] = Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))

// Mirrors the API rules in modules/M11 section 5. The code is accepted in any case and sent upper-cased.
export const classFormSchema = z.object({
  name: z.string().trim().min(2, 'Name must be 2–40 characters.').max(40, 'Name must be 2–40 characters.'),
  code: z.string().trim().regex(/^[A-Za-z0-9_]{2,30}$/, 'Code uses 2–30 letters, digits or underscores.'),
  stage: z.string().refine((v) => v in STAGE_LABELS, 'Pick a value from the list.'),
  levelOrder: z
    .number({ error: 'Level order must be a number.' })
    .int('Level order must be a whole number.')
    .min(0, 'Level order must be 0–50.')
    .max(50, 'Level order must be 0–50.'),
  isActive: z.boolean(),
})
export type ClassForm = z.infer<typeof classFormSchema>

export const classesConfig: MasterConfig<ClassRow, ClassForm> = {
  key: 'classes',
  singular: 'class',
  plural: 'classes',
  title: 'Classes',
  description: 'Grades and levels learners study at. The level order is used to match a child to teachers who cover a range of classes.',
  apiPath: '/classes',
  readPermission: 'education_masters.read',
  managePermission: 'education_masters.manage',
  searchPlaceholder: 'Search by name or code',
  fields: [
    { name: 'name', label: 'Name', kind: 'text', placeholder: 'Class 11 (Droppers)', maxLength: 40 },
    { name: 'code', label: 'Code', kind: 'text', placeholder: 'CLASS_11_DROP', maxLength: 30, hint: 'Capital letters, digits and underscores. The apps use it, so it can’t change later.', immutable: true },
    { name: 'stage', label: 'Stage', kind: 'select', options: STAGE_OPTIONS, hint: 'Groups classes in filters and recommendations' },
    { name: 'levelOrder', label: 'Level order', kind: 'number', hint: 'Class 1 = 1 … Class 12 = 12, then higher levels (0–50)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive classes are hidden in the app' },
  ],
  schema: classFormSchema,
  defaultValues: { name: '', code: '', stage: '', levelOrder: 0, isActive: true },
  toFormValues: (c) => ({ name: c.name, code: c.code, stage: c.stage, levelOrder: c.levelOrder, isActive: c.isActive }),
  toPayload: (v) => ({ name: v.name.trim(), code: v.code.trim().toUpperCase(), stage: v.stage, levelOrder: v.levelOrder, isActive: v.isActive }),
  columns: [
    { id: 'name', header: 'Class', sortKey: 'name', cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: 'code', header: 'Code', cell: (c) => <span className="font-mono text-xs">{c.code}</span> },
    { id: 'stage', header: 'Stage', cell: (c) => STAGE_LABELS[c.stage] ?? c.stage },
    { id: 'level', header: 'Level', sortKey: 'levelOrder', align: 'right', cell: (c) => c.levelOrder },
  ],
  filters: [{ param: 'stage', label: 'Stage', allLabel: 'All stages', options: STAGE_OPTIONS }],
  usage: (c) => {
    const parts = [c.teacherCount > 0 ? countLabel(c.teacherCount, 'teacher') : null, c.childCount > 0 ? countLabel(c.childCount, 'child', 'children') : null].filter(Boolean)
    return { count: c.teacherCount + c.childCount, label: parts.length > 0 ? parts.join(' · ') : 'Unused' }
  },
  referenceNames: {
    teacher_classes: 'teachers',
    parent_children: 'children',
    students: 'students',
    leads: 'leads',
    institute_batches: 'institute batches',
    institute_teacher_classes: 'institute teacher classes',
  },
  reorder: {
    sort: 'levelOrder',
    warning: 'Teacher class ranges and recommendations use this order, so changing it changes which teachers match which children.',
  },
}
