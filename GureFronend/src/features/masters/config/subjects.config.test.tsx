import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, fetchOptions, fetchScopedOptions, listMasters, mergeMaster, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { describeRange, subjectFormSchema, subjectsConfig } from './subjects.config'
import type { Subject } from './subjects.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { name: 'Vedic Maths', category: 'academic', parentSubjectId: '', aliases: 'speed maths, vedic', minClassOrder: '4', maxClassOrder: '12', isTrending: false, sortOrder: 3, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const physics: Subject = { ...base, id: 's-phy', name: 'Physics', slug: 'physics', category: 'academic', parent: null, parentSubjectId: null, aliases: [], classRange: { min: 9, max: 14 }, minClassOrder: 9, maxClassOrder: 14, isTrending: true, isActive: true, sortOrder: 1, teacherCount: 2310, iconFileId: null, iconUrl: null }
const organic: Subject = { ...physics, id: 's-org', name: 'Organic Chemistry', slug: 'organic-chemistry', parent: { id: 's-chem', name: 'Chemistry' }, parentSubjectId: 's-chem', aliases: ['org chem', 'organic'], classRange: { min: null, max: null }, minClassOrder: null, maxClassOrder: null, isTrending: false, teacherCount: 0, iconUrl: 'https://cdn.example.com/org.png' }
const subjectOptions = [
  { value: 's-chem', label: 'Chemistry' },
  { value: 's-phy', label: 'Physics' },
]
const classLevels = [
  { value: '4', label: 'Class 4' },
  { value: '9', label: 'Class 9' },
  { value: '12', label: 'Class 12' },
]

const messages = (input: object) => {
  const result = subjectFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
  vi.mocked(fetchOptions).mockImplementation(async (path) => (path === '/classes' ? classLevels : subjectOptions))
})

describe('describeRange', () => {
  it.each([
    [null, null, 'All levels'],
    [6, null, 'From level 6'],
    [null, 5, 'Up to level 5'],
    [9, 14, 'Level 9–14'],
    [7, 7, 'Level 7'],
  ])('describes %s to %s as "%s"', (min, max, text) => {
    expect(describeRange(min, max)).toBe(text)
  })
})

describe('subjectFormSchema', () => {
  it('accepts a valid subject, blank optional fields and aliases with stray spaces', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, aliases: '', minClassOrder: '', maxClassOrder: '' })).toEqual([])
    expect(messages({ ...valid, aliases: ' Maths ,  math ,' })).toEqual([])
  })

  it.each([
    [{ name: 'M' }, 'name: Name must be 2–60 characters.'],
    [{ category: 'astrology' }, 'category: Pick a value from the list.'],
    [{ category: '' }, 'category: Pick a value from the list.'],
    [{ aliases: 'a' }, 'aliases: Each alias must be 2–40 characters.'],
    [{ aliases: 'maths, Maths' }, 'aliases: Each alias can only be listed once.'],
    [{ aliases: Array.from({ length: 16 }, (_, i) => `alias ${i}`).join(', ') }, 'aliases: A subject can have up to 15 aliases.'],
    [{ minClassOrder: '12', maxClassOrder: '4' }, 'minClassOrder: The first class can’t come after the last class.'],
    [{ sortOrder: 10000 }, 'sortOrder: Order must be 0–9,999.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('subjectsConfig', () => {
  it('turns the form into the API body: lower-case aliases, numeric levels, null for empty', () => {
    expect(subjectsConfig.toPayload({ ...valid, aliases: ' Speed  Maths , VEDIC ' })).toEqual({
      name: 'Vedic Maths',
      category: 'academic',
      parentSubjectId: null,
      aliases: ['speed maths', 'vedic'],
      minClassOrder: 4,
      maxClassOrder: 12,
      isTrending: false,
      sortOrder: 3,
      isActive: true,
    })
    expect(subjectsConfig.toPayload({ ...valid, parentSubjectId: 's-chem', minClassOrder: '', maxClassOrder: '' })).toMatchObject({ parentSubjectId: 's-chem', minClassOrder: null, maxClassOrder: null })
  })

  it('shows aliases, the parent and open bounds as form text', () => {
    expect(subjectsConfig.toFormValues(organic)).toMatchObject({ aliases: 'org chem, organic', parentSubjectId: 's-chem', minClassOrder: '', maxClassOrder: '' })
    expect(subjectsConfig.toFormValues(physics)).toMatchObject({ aliases: '', parentSubjectId: '', minClassOrder: '9', maxClassOrder: '14' })
  })

  it('uses the class level, not the id, as the value of the class range selects', () => {
    const range = subjectsConfig.fields.filter((f) => f.name.endsWith('ClassOrder'))
    expect(range.map((f) => [f.optionsFrom, f.optionsValueKey])).toEqual([['/classes', 'levelOrder'], ['/classes', 'levelOrder']])
  })

  it('keeps an inactive parent selectable', () => {
    expect(subjectsConfig.selectedOption?.(organic, 'parentSubjectId')).toEqual({ value: 's-chem', label: 'Chemistry' })
    expect(subjectsConfig.selectedOption?.(physics, 'parentSubjectId')).toBeNull()
  })

  it('supports merging into another subject', () => {
    expect(subjectsConfig.merge?.targetKey).toBe('intoSubjectId')
  })
})

describe('subjects list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [physics, organic], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })

  it('shows trending, category, class range, parent, aliases and teachers', async () => {
    withClient(<MasterListPage config={subjectsConfig} />)
    const table = within(await screen.findByRole('table', { name: 'Subjects' }))
    const phy = table.getByText('Physics').closest('tr')!
    expect(within(phy).getByText('Trending')).toBeInTheDocument()
    expect(within(phy).getByText('Academic')).toBeInTheDocument()
    expect(within(phy).getByText('Level 9–14')).toBeInTheDocument()
    expect(within(phy).getByText('2310 teachers')).toBeInTheDocument()
    const org = table.getByText('Organic Chemistry').closest('tr')!
    expect(within(org).getByText('Under Chemistry')).toBeInTheDocument()
    expect(within(org).getByText('All levels')).toBeInTheDocument()
    expect(org.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/org.png')
    expect(within(org).queryByText('Trending')).toBeNull()
  })

  it('filters by category, parent, trending and class', async () => {
    withClient(<MasterListPage config={subjectsConfig} />)
    await screen.findByText('Physics')
    await screen.findAllByRole('option', { name: 'Class 9' })
    const last = () => vi.mocked(listMasters).mock.calls.at(-1)![1].extra
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'language' } })
    fireEvent.change(screen.getByLabelText('Trending'), { target: { value: 'true' } })
    fireEvent.change(screen.getByLabelText('Offered for'), { target: { value: 'c-9' } })
    await waitFor(() => expect(last()).toMatchObject({ category: 'language', trending: 'true' }))
  })

  it('merges a subject from its row', async () => {
    vi.mocked(fetchScopedOptions).mockResolvedValue([{ value: 's-phy', label: 'Physics' }, { value: 's-chem', label: 'Chemistry' }])
    vi.mocked(mergeMaster).mockResolvedValue({ moved: { teacher_subjects: 5 } })
    withClient(<MasterListPage config={subjectsConfig} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge Organic Chemistry' }))
    const dialog = await screen.findByRole('dialog', { name: 'Merge Organic Chemistry' })
    await within(dialog).findByRole('option', { name: 'Chemistry' })
    expect(fetchScopedOptions).toHaveBeenCalledWith('/subjects', {})
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 's-chem' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Merged Organic Chemistry into Chemistry. 5 records moved.')
    expect(mergeMaster).toHaveBeenCalledWith('/subjects', 's-org', 'intoSubjectId', 's-chem', undefined)
  })
})

describe('subject form', () => {
  const open = (row: Subject | null) => withClient(<MasterFormDrawer config={subjectsConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('creates a subject with a parent, aliases and a class range', async () => {
    vi.mocked(createMaster).mockResolvedValue(organic)
    open(null)
    await screen.findAllByRole('option', { name: 'Class 12' })
    expect(fetchOptions).toHaveBeenCalledWith('/classes', 'levelOrder')
    type('Name', 'Organic Chemistry')
    type('Category', 'academic')
    type('Parent subject', 's-chem')
    type('Aliases', 'Org Chem, organic')
    type('First class', '9')
    type('Last class', '12')
    fireEvent.click(screen.getByRole('button', { name: 'Add subject' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/subjects', {
      name: 'Organic Chemistry',
      category: 'academic',
      parentSubjectId: 's-chem',
      aliases: ['org chem', 'organic'],
      minClassOrder: 9,
      maxClassOrder: 12,
      isTrending: false,
      sortOrder: 0,
      isActive: true,
    })
  })

  it('rejects a range that runs backwards before calling the API', async () => {
    open(null)
    await screen.findAllByRole('option', { name: 'Class 12' })
    type('Name', 'Algebra')
    type('Category', 'academic')
    type('First class', '12')
    type('Last class', '4')
    fireEvent.click(screen.getByRole('button', { name: 'Add subject' }))
    expect(await screen.findByText('The first class can’t come after the last class.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('names the current trending subjects when all ten places are taken', async () => {
    vi.mocked(updateMaster).mockRejectedValue(
      new ApiError(409, 'CONFLICT_STATE', 'Up to 10 subjects can be trending.', { trending: [{ id: 's-phy', name: 'Physics' }, { id: 's-mat', name: 'Mathematics' }] }),
    )
    open({ ...physics, isTrending: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Trending' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Up to 10 subjects can be trending. Currently trending: Physics, Mathematics.')
  })

  it('shows a parent that is no longer active, and clears it with null', async () => {
    vi.mocked(fetchOptions).mockImplementation(async (path) => (path === '/classes' ? classLevels : [{ value: 's-phy', label: 'Physics' }])) // Chemistry not active
    vi.mocked(updateMaster).mockResolvedValue({ ...organic, parent: null, parentSubjectId: null } as never)
    open(organic)
    await screen.findByRole('option', { name: 'Physics' })
    expect(screen.getByRole('option', { name: 'Chemistry' })).toBeInTheDocument()
    expect(screen.getByLabelText('Parent subject')).toHaveValue('s-chem')
    type('Parent subject', '')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/subjects', 's-org', { parentSubjectId: null }, '2026-09-20T08:11:02.114Z'))
  })

  it('sends only the aliases when only they changed, and nothing for the same aliases retyped', async () => {
    const onClose = vi.fn()
    vi.mocked(updateMaster).mockResolvedValue(organic as never)
    withClient(<MasterFormDrawer config={subjectsConfig} row={organic} onClose={onClose} onSaved={vi.fn()} />)
    type('Aliases', 'ORG CHEM,  organic')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateMaster).not.toHaveBeenCalled()
    type('Aliases', 'organic, org chem')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/subjects', 's-org', { aliases: ['organic', 'org chem'] }, '2026-09-20T08:11:02.114Z'))
  })
})
