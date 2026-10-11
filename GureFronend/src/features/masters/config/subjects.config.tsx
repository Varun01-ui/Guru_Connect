import { z } from 'zod'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import type { MasterConfig, MasterRow, SelectOption } from '../types'
import { countLabel } from './labels'

export type Subject = MasterRow & {
  slug: string
  category: string
  parent: { id: string; name: string } | null
  parentSubjectId: string | null
  aliases: string[]
  classRange: { min: number | null; max: number | null }
  minClassOrder: number | null
  maxClassOrder: number | null
  isTrending: boolean
  sortOrder: number
  teacherCount: number
  iconFileId: string | null
  iconUrl: string | null
}

export const CATEGORY_LABELS: Record<string, string> = {
  academic: 'Academic',
  competitive_exam: 'Competitive exam',
  language: 'Language',
  music_arts: 'Music & arts',
  coding_skills: 'Coding & skills',
  other: 'Other',
}
const CATEGORY_OPTIONS: SelectOption[] = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))
const YES_NO: SelectOption[] = [
  { value: 'true', label: 'Trending' },
  { value: 'false', label: 'Not trending' },
]

const splitAliases = (text: string) => text.split(',').map((a) => a.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean)
const toLevel = (v: string) => (v === '' ? null : Number(v))

/** "Level 9–14", "All levels", "From level 6", "Up to level 5": the bounds are class levels, not class names. */
export function describeRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'All levels'
  if (max === null) return `From level ${min}`
  if (min === null) return `Up to level ${max}`
  return min === max ? `Level ${min}` : `Level ${min}–${max}`
}

// Mirrors the API rules in modules/M12 section 5. Aliases are typed in one box, separated by commas.
export const subjectFormSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be 2–60 characters.').max(60, 'Name must be 2–60 characters.'),
    category: z.string().refine((v) => v in CATEGORY_LABELS, 'Pick a value from the list.'),
    parentSubjectId: z.string(),
    aliases: z.string().superRefine((text, ctx) => {
      const list = splitAliases(text)
      if (list.some((a) => a.length < 2 || a.length > 40)) ctx.addIssue({ code: 'custom', message: 'Each alias must be 2–40 characters.' })
      else if (new Set(list).size !== list.length) ctx.addIssue({ code: 'custom', message: 'Each alias can only be listed once.' })
      else if (list.length > 15) ctx.addIssue({ code: 'custom', message: 'A subject can have up to 15 aliases.' })
    }),
    minClassOrder: z.string(),
    maxClassOrder: z.string(),
    isTrending: z.boolean(),
    sortOrder: z
      .number({ error: 'Order must be a number.' })
      .int('Order must be a whole number.')
      .min(0, 'Order must be 0–9,999.')
      .max(9999, 'Order must be 0–9,999.'),
    isActive: z.boolean(),
  })
  .refine((v) => v.minClassOrder === '' || v.maxClassOrder === '' || Number(v.minClassOrder) <= Number(v.maxClassOrder), {
    path: ['minClassOrder'],
    message: 'The first class can’t come after the last class.',
  })
export type SubjectForm = z.infer<typeof subjectFormSchema>

export const subjectsConfig: MasterConfig<Subject, SubjectForm> = {
  key: 'subjects',
  singular: 'subject',
  plural: 'subjects',
  title: 'Subjects',
  description: 'Subjects, exams, languages and skills teachers can teach. Aliases make search forgiving; the class range keeps a Class 3 parent from seeing Class 12 physics.',
  apiPath: '/subjects',
  readPermission: 'education_masters.read',
  managePermission: 'education_masters.manage',
  searchPlaceholder: 'Search by name or alias',
  fields: [
    { name: 'name', label: 'Name', kind: 'text', placeholder: 'Vedic Maths', maxLength: 60 },
    { name: 'category', label: 'Category', kind: 'select', options: CATEGORY_OPTIONS },
    { name: 'parentSubjectId', label: 'Parent subject', kind: 'select', optionsFrom: '/subjects', hint: 'Optional, e.g. Organic Chemistry under Chemistry. Only two levels are allowed.' },
    { name: 'aliases', label: 'Aliases', kind: 'text', placeholder: 'maths, math', hint: 'Other names people search by, separated by commas (up to 15)' },
    { name: 'minClassOrder', label: 'First class', kind: 'select', optionsFrom: '/classes', optionsValueKey: 'levelOrder', hint: 'Leave empty if it applies from the lowest class' },
    { name: 'maxClassOrder', label: 'Last class', kind: 'select', optionsFrom: '/classes', optionsValueKey: 'levelOrder', hint: 'Leave empty if it applies up to the highest class' },
    { name: 'isTrending', label: 'Trending', kind: 'switch', hint: 'Pinned on the app home screen. Up to 10 subjects can be trending.' },
    { name: 'sortOrder', label: 'Order', kind: 'number', hint: 'Lower numbers appear first (0–9,999)' },
    { name: 'isActive', label: 'Active', kind: 'switch', hint: 'Inactive subjects are hidden in the app' },
  ],
  schema: subjectFormSchema,
  defaultValues: { name: '', category: '', parentSubjectId: '', aliases: '', minClassOrder: '', maxClassOrder: '', isTrending: false, sortOrder: 0, isActive: true },
  toFormValues: (s) => ({
    name: s.name,
    category: s.category,
    parentSubjectId: s.parentSubjectId ?? '',
    aliases: s.aliases.join(', '),
    minClassOrder: s.minClassOrder === null ? '' : String(s.minClassOrder),
    maxClassOrder: s.maxClassOrder === null ? '' : String(s.maxClassOrder),
    isTrending: s.isTrending,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
  }),
  toPayload: (v) => ({
    name: v.name.trim(),
    category: v.category,
    parentSubjectId: v.parentSubjectId === '' ? null : v.parentSubjectId,
    aliases: splitAliases(v.aliases),
    minClassOrder: toLevel(v.minClassOrder),
    maxClassOrder: toLevel(v.maxClassOrder),
    isTrending: v.isTrending,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
  }),
  columns: [
    {
      id: 'name',
      header: 'Subject',
      sortKey: 'name',
      cell: (s) => (
        <span className="flex items-center gap-3">
          {s.iconUrl ? (
            <img src={s.iconUrl} alt="" className="h-7 w-7 rounded-md object-cover" />
          ) : (
            <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-xs font-semibold text-[var(--color-accent)]">
              {s.name.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="flex flex-col">
            <span className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.isTrending ? <StatusBadge tone="warn">Trending</StatusBadge> : null}
            </span>
            <span className="text-xs text-[var(--color-fg-muted)]">{s.parent ? `Under ${s.parent.name}` : s.aliases.length > 0 ? `Also: ${s.aliases.slice(0, 3).join(', ')}` : s.slug}</span>
          </span>
        </span>
      ),
    },
    { id: 'category', header: 'Category', cell: (s) => CATEGORY_LABELS[s.category] ?? s.category },
    { id: 'range', header: 'Classes', cell: (s) => describeRange(s.classRange.min, s.classRange.max) },
    { id: 'order', header: 'Order', sortKey: 'sortOrder', align: 'right', cell: (s) => s.sortOrder },
  ],
  filters: [
    { param: 'category', label: 'Category', allLabel: 'All categories', options: CATEGORY_OPTIONS },
    { param: 'parentId', label: 'Parent', allLabel: 'Any', optionsFrom: '/subjects' },
    { param: 'trending', label: 'Trending', allLabel: 'All', options: YES_NO },
    { param: 'classId', label: 'Offered for', allLabel: 'Any class', optionsFrom: '/classes' },
  ],
  usage: (s) => ({ count: s.teacherCount, label: s.teacherCount === 0 ? 'Unused' : countLabel(s.teacherCount, 'teacher') }),
  referenceNames: {
    teacher_subjects: 'teachers',
    parent_child_subjects: 'children',
    institute_teacher_subjects: 'institute teachers',
    leads: 'leads',
    subjects: 'sub-subjects',
    institute_batches: 'institute batches',
  },
  selectedOption: (s, field) => (field === 'parentSubjectId' && s.parent ? { value: s.parent.id, label: s.parent.name } : null),
  // FR-12.S1: fold a duplicate subject into the one it should have been.
  merge: {
    targetKey: 'intoSubjectId',
    warning: 'Teachers, children and batches using this subject move to the one you pick, its name becomes an alias of that one, and this subject is removed.',
  },
}
