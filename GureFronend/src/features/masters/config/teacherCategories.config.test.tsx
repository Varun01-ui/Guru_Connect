import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../../auth/usePermissions'
import { listMasters, setMasterActive, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { teacherCategoriesConfig, teacherCategoryFormSchema } from './teacherCategories.config'
import type { TeacherCategory } from './teacherCategories.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { name: 'Sports Coach', description: 'Cricket and football', sortOrder: 8, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const homeTutor: TeacherCategory = {
  ...base,
  id: 'cat-ht',
  name: 'Home Tutor',
  slug: 'home-tutor',
  description: 'Teaches at the student’s home',
  iconFileId: 'f1',
  iconUrl: 'https://cdn.example.com/home.png',
  isActive: true,
  sortOrder: 1,
  teacherCount: 3890,
  childPreferenceCount: 1204,
}
const sports: TeacherCategory = { ...homeTutor, id: 'cat-sp', name: 'Sports Coach', slug: 'sports-coach', description: null, iconFileId: null, iconUrl: null, sortOrder: 8, teacherCount: 0, childPreferenceCount: 0 }
const oneTeacher: TeacherCategory = { ...sports, id: 'cat-one', name: 'Chess Coach', slug: 'chess-coach', teacherCount: 1 }

const messages = (input: object) => {
  const result = teacherCategoryFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
})

describe('teacherCategoryFormSchema', () => {
  it('accepts a valid category and a blank description', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, description: '' })).toEqual([])
  })

  it.each([
    [{ name: 'A' }, 'name: Name must be 2–50 characters.'],
    [{ name: 'x'.repeat(51) }, 'name: Name must be 2–50 characters.'],
    [{ description: 'x'.repeat(201) }, 'description: Description can be up to 200 characters.'],
    [{ sortOrder: -1 }, 'sortOrder: Order must be 0–9,999.'],
    [{ sortOrder: 1.5 }, 'sortOrder: Order must be a whole number.'],
    [{ sortOrder: Number.NaN }, 'sortOrder: Order must be a number.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('teacherCategoriesConfig', () => {
  it('sends a blank description as null', () => {
    expect(teacherCategoriesConfig.toPayload({ ...valid, description: '  ' })).toEqual({ name: 'Sports Coach', description: null, sortOrder: 8, isActive: true })
  })

  it('does not put the generated slug or the icon in the form', () => {
    expect(teacherCategoriesConfig.fields.map((f) => f.name)).toEqual(['name', 'description', 'sortOrder', 'isActive'])
  })

  it.each([
    [{ teacherCount: 0, childPreferenceCount: 0 }, { count: 0, label: 'Unused' }],
    [{ teacherCount: 1, childPreferenceCount: 0 }, { count: 1, label: '1 teacher' }],
    [{ teacherCount: 3890, childPreferenceCount: 1204 }, { count: 5094, label: '3890 teachers · 1204 preferences' }],
    [{ teacherCount: 0, childPreferenceCount: 1 }, { count: 1, label: '1 preference' }],
  ])('describes usage for %j', (counts, expected) => {
    expect(teacherCategoriesConfig.usage({ ...sports, ...counts })).toEqual(expected)
  })

  it('asks for confirmation only when teachers use the category', () => {
    expect(teacherCategoriesConfig.confirmDeactivate?.(sports)).toBeNull()
    expect(teacherCategoriesConfig.confirmDeactivate?.(oneTeacher)).toBe('1 teacher uses Chess Coach. It stays on their profiles, but disappears from filters and sign-up choices.')
    expect(teacherCategoriesConfig.confirmDeactivate?.(homeTutor)).toMatch(/^3890 teachers use Home Tutor\./)
  })
})

describe('teacher categories list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [homeTutor, sports, oneTeacher], meta: { page: 1, pageSize: 20, total: 3, totalPages: 1 } })
    vi.mocked(setMasterActive).mockResolvedValue(homeTutor as never)
  })

  it('shows the icon (or an initial), slug, order and usage', async () => {
    withClient(<MasterListPage config={teacherCategoriesConfig} />)
    const withIcon = (await screen.findByText('Home Tutor')).closest('tr')!
    expect(withIcon.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/home.png')
    expect(within(withIcon).getByText('home-tutor')).toBeInTheDocument()
    expect(within(withIcon).getByText('3890 teachers · 1204 preferences')).toBeInTheDocument()
    const noIcon = screen.getByText('Sports Coach').closest('tr')!
    expect(noIcon.querySelector('img')).toBeNull()
    expect(within(noIcon).getByText('S')).toBeInTheDocument()
    expect(within(noIcon).getByText('Unused')).toBeInTheDocument()
  })

  it('shows how many teachers are affected before switching a used category off', async () => {
    withClient(<MasterListPage config={teacherCategoriesConfig} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Home Tutor active' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Deactivate Home Tutor?')
    expect(dialog).toHaveTextContent('3890 teachers use Home Tutor.')
    expect(setMasterActive).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(setMasterActive).toHaveBeenCalledWith('/teacher-categories', 'cat-ht', false))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('leaves the category on when the confirmation is cancelled', async () => {
    withClient(<MasterListPage config={teacherCategoriesConfig} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Chess Coach active' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(setMasterActive).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: 'Chess Coach active' })).toBeChecked()
  })

  it('switches an unused category off straight away, and on without asking', async () => {
    withClient(<MasterListPage config={teacherCategoriesConfig} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Sports Coach active' }))
    await waitFor(() => expect(setMasterActive).toHaveBeenCalledWith('/teacher-categories', 'cat-sp', false))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers reordering with the home-grid warning', async () => {
    vi.mocked(listMasters).mockImplementation((async (_path: string, params: { pageSize: number }) => ({ data: [homeTutor, sports], meta: { page: 1, pageSize: params.pageSize, total: 2, totalPages: 1 } })) as never)
    withClient(<MasterListPage config={teacherCategoriesConfig} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reorder' }))
    expect(await screen.findByText(/first 8 active categories fill the category grid/)).toBeInTheDocument()
  })
})

describe('teacher category form', () => {
  it('edits the description and clears it with null', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...homeTutor, description: null } as never)
    withClient(<MasterFormDrawer config={teacherCategoriesConfig} row={homeTutor} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/teacher-categories', 'cat-ht', { description: null }, '2026-09-20T08:11:02.114Z'))
  })
})
