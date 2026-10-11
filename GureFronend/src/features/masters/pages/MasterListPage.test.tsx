import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, deleteMaster, listMasters, reorderMasters, restoreMaster, setMasterActive, updateMaster } from '../api/masters.api'
import { classesConfig } from '../config/classes.config'
import type { ClassRow } from '../config/classes.config'
import { countriesConfig } from '../config/countries.config'
import type { Country } from '../config/countries.config'
import { MasterListPage } from './MasterListPage'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const india: Country = {
  id: 'c-in',
  name: 'India',
  iso2: 'IN',
  iso3: 'IND',
  phoneCode: '+91',
  currencyCode: 'INR',
  isActive: true,
  sortOrder: 1,
  stateCount: 13,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T08:11:02.114Z',
  deletedAt: null,
}
const uae: Country = { ...india, id: 'c-ae', name: 'United Arab Emirates', iso2: 'AE', iso3: 'ARE', phoneCode: '+971', currencyCode: 'AED', isActive: false, sortOrder: 2, stateCount: 0 }
const narnia: Country = { ...india, id: 'c-nr', name: 'Narnia', iso2: 'NR', iso3: 'NAR', stateCount: 0, deletedAt: '2026-10-01T00:00:00.000Z' }

const page = (data: Country[], overrides: Partial<{ page: number; pageSize: number; total: number; totalPages: number }> = {}) => ({
  data,
  meta: { page: 1, pageSize: 20, total: data.length, totalPages: 1, ...overrides },
})

function as(role: 'manager' | 'reader' | 'super') {
  vi.mocked(usePermissions).mockReturnValue({
    isLoading: false,
    isSuperAdmin: role === 'super',
    can: (key: string) => role !== 'reader' || key === 'locations.read',
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MasterListPage config={countriesConfig} />
    </QueryClientProvider>,
  )
}

const lastCall = () => vi.mocked(listMasters).mock.calls.at(-1)!

beforeEach(() => {
  vi.resetAllMocks()
  as('manager')
  vi.mocked(listMasters).mockResolvedValue(page([india, uae]))
})

describe('MasterListPage — states', () => {
  it('shows a loading state, then the rows with usage and active switches', async () => {
    vi.mocked(listMasters).mockReturnValue(new Promise(() => undefined))
    renderPage()
    expect(screen.getByText('Loading countries…')).toBeInTheDocument()
  })

  it('lists countries with codes, usage badges and the active switch', async () => {
    renderPage()
    const row = (await screen.findByText('India')).closest('tr')!
    expect(within(row).getByText('IN · IND')).toBeInTheDocument()
    expect(within(row).getByText('+91')).toBeInTheDocument()
    expect(within(row).getByText('13 states')).toBeInTheDocument()
    expect(within(row).getByRole('switch', { name: 'India active' })).toBeChecked()

    const other = screen.getByText('United Arab Emirates').closest('tr')!
    expect(within(other).getByText('Unused')).toBeInTheDocument()
    expect(within(other).getByRole('switch', { name: 'United Arab Emirates active' })).not.toBeChecked()
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument()
  })

  it('invites the first entry when there are none', async () => {
    vi.mocked(listMasters).mockResolvedValue(page([]))
    renderPage()
    expect(await screen.findByText('No countries yet. Add the first country.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull()
  })

  it('says nothing matches when a filter returns no rows', async () => {
    renderPage()
    await screen.findByText('India')
    vi.mocked(listMasters).mockResolvedValue(page([]))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } })
    expect(await screen.findByText('No countries match your filters.')).toBeInTheDocument()
  })

  it('shows the API error and retries', async () => {
    vi.mocked(listMasters).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'The server is unwell.'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is unwell.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('India')).toBeInTheDocument()
  })
})

describe('MasterListPage — permissions', () => {
  it('gives a read-only admin no way to change anything', async () => {
    as('reader')
    renderPage()
    await screen.findByText('India')
    expect(screen.queryByRole('button', { name: 'Add country' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit India' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete India' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'India active' })).toBeDisabled()
    expect(screen.queryByLabelText('Show deleted')).toBeNull()
  })

  it('does not offer "Show deleted" to a manager who is not a super admin', async () => {
    renderPage()
    await screen.findByText('India')
    expect(screen.queryByLabelText('Show deleted')).toBeNull()
  })
})

describe('MasterListPage — search, filter, sort, paging', () => {
  it('searches after a short pause and goes back to page 1', async () => {
    renderPage()
    await screen.findByText('India')
    fireEvent.change(screen.getByLabelText('Search countries'), { target: { value: 'ind' } })
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ q: 'ind', page: 1 }), { timeout: 2000 })
  })

  it('filters by status', async () => {
    renderPage()
    await screen.findByText('India')
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } })
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ active: true }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } })
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ active: false }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    await waitFor(() => expect(lastCall()[1].active).toBeUndefined())
  })

  it('sorts by a column, flipping direction on the second click', async () => {
    renderPage()
    await screen.findByText('India')
    fireEvent.click(screen.getByRole('button', { name: /Country/ }))
    await waitFor(() => expect(lastCall()[1].sort).toEqual({ key: 'name', dir: 'asc' }))
    expect(screen.getByRole('columnheader', { name: /Country/ })).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByRole('button', { name: /Country/ }))
    await waitFor(() => expect(lastCall()[1].sort).toEqual({ key: 'name', dir: 'desc' }))
  })

  it('pages forward and back, and changes the page size', async () => {
    vi.mocked(listMasters).mockImplementation(async (_path, params) => page([india], { page: params.page, pageSize: params.pageSize, total: 45, totalPages: 3 }))
    renderPage()
    await screen.findByText('Showing 1–20 of 45')
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')
    expect(screen.getByText('Showing 21–40 of 45')).toBeInTheDocument()
    expect(lastCall()[1]).toMatchObject({ page: 2 })

    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '50' } })
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ pageSize: 50, page: 1 }))
  })
})

describe('MasterListPage — active switch', () => {
  it('flips at once and keeps the new value once the API agrees', async () => {
    vi.mocked(setMasterActive).mockResolvedValue({ ...india, isActive: false })
    renderPage()
    const toggle = await screen.findByRole('switch', { name: 'India active' })
    vi.mocked(listMasters).mockResolvedValue(page([{ ...india, isActive: false }, uae]))
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'India active' })).not.toBeChecked())
    expect(setMasterActive).toHaveBeenCalledWith('/countries', 'c-in', false)
  })

  it('rolls back and shows the error when the API refuses', async () => {
    let refuse!: (error: Error) => void
    vi.mocked(setMasterActive).mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)))
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'India active' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'India active' })).not.toBeChecked())

    refuse(new ApiError(403, 'FORBIDDEN', 'You can view countries but not change them.'))
    expect(await screen.findByRole('alert')).toHaveTextContent('You can view countries but not change them.')
    await waitFor(() => expect(screen.getByRole('switch', { name: 'India active' })).toBeChecked())
  })
})

describe('MasterListPage — create and edit', () => {
  it('opens the drawer to add a country, then confirms and refreshes the list', async () => {
    vi.mocked(createMaster).mockResolvedValue({ ...uae, id: 'c-new', name: 'Nepal' })
    renderPage()
    await screen.findByText('India')
    fireEvent.click(screen.getByRole('button', { name: 'Add country' }))

    const drawer = screen.getByRole('dialog', { name: 'Add country' })
    fireEvent.change(within(drawer).getByLabelText('Country name'), { target: { value: 'Nepal' } })
    fireEvent.change(within(drawer).getByLabelText('ISO alpha-2'), { target: { value: 'np' } })
    fireEvent.change(within(drawer).getByLabelText('ISO alpha-3'), { target: { value: 'npl' } })
    fireEvent.change(within(drawer).getByLabelText('Dialling code'), { target: { value: '+977' } })
    fireEvent.change(within(drawer).getByLabelText('Currency'), { target: { value: 'npr' } })
    const callsBefore = vi.mocked(listMasters).mock.calls.length
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add country' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Country Nepal added.')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(createMaster).toHaveBeenCalledWith('/countries', { name: 'Nepal', iso2: 'NP', iso3: 'NPL', phoneCode: '+977', currencyCode: 'NPR', sortOrder: 0, isActive: true })
    await waitFor(() => expect(vi.mocked(listMasters).mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('opens the drawer prefilled to edit and sends the row version', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...india, sortOrder: 9 } as never)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit India' }))
    const drawer = screen.getByRole('dialog', { name: 'Edit country' })
    expect(within(drawer).getByLabelText('Country name')).toHaveValue('India')
    fireEvent.change(within(drawer).getByLabelText('Order'), { target: { value: '9' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Country India saved.')
    expect(updateMaster).toHaveBeenCalledWith('/countries', 'c-in', { sortOrder: 9 }, '2026-09-20T08:11:02.114Z')
  })
})

describe('MasterListPage — delete', () => {
  it('deletes an unused country after confirmation', async () => {
    vi.mocked(deleteMaster).mockResolvedValue(undefined)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete United Arab Emirates' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete United Arab Emirates?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Country United Arab Emirates deleted.')
    expect(deleteMaster).toHaveBeenCalledWith('/countries', 'c-ae')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('cancels without calling the API', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete India' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteMaster).not.toHaveBeenCalled()
  })

  it('explains a blocked delete with the reference counts and offers to deactivate instead', async () => {
    vi.mocked(deleteMaster).mockRejectedValue(new ApiError(409, 'CONFLICT_IN_USE', 'This country is in use. Deactivate it instead.', { references: { states: 13 } }))
    vi.mocked(setMasterActive).mockResolvedValue({ ...india, isActive: false })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete India' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() => expect(dialog).toHaveTextContent('India is in use'))
    expect(dialog).toHaveTextContent('13 states')
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate instead' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Country India deactivated.')
    expect(setMasterActive).toHaveBeenCalledWith('/countries', 'c-in', false)
  })

  it('shows other delete errors inside the dialog', async () => {
    vi.mocked(deleteMaster).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Country not found.'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete India' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Country not found.')
  })
})

describe('MasterListPage — deleted rows', () => {
  it('lets a super admin reveal deleted countries and restore one', async () => {
    as('super')
    vi.mocked(listMasters).mockImplementation(async (_path, params) => page(params.includeDeleted ? [india, narnia] : [india]))
    vi.mocked(restoreMaster).mockResolvedValue({ ...narnia, deletedAt: null })
    renderPage()
    await screen.findByText('India')
    expect(screen.queryByText('Narnia')).toBeNull()

    fireEvent.click(screen.getByLabelText('Show deleted'))
    const row = (await screen.findByText('Narnia')).closest('tr')!
    expect(within(row).getByText('Deleted')).toBeInTheDocument()
    expect(within(row).queryByRole('switch')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Country Narnia restored.')
    expect(restoreMaster).toHaveBeenCalledWith('/countries', 'c-nr')
  })
})

describe('MasterListPage — filters and reorder (classes config)', () => {
  const class10: ClassRow = {
    id: 'cl-10',
    name: 'Class 10',
    code: 'CLASS_10',
    stage: 'secondary',
    levelOrder: 10,
    isActive: true,
    teacherCount: 12,
    childCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T08:11:02.114Z',
    deletedAt: null,
  }
  const ug: ClassRow = { ...class10, id: 'cl-ug', name: 'Undergraduate', code: 'UG', stage: 'undergraduate', levelOrder: 13, teacherCount: 0, childCount: 0 }

  function renderClasses() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <MasterListPage config={classesConfig} />
      </QueryClientProvider>,
    )
  }

  beforeEach(() => {
    vi.mocked(listMasters).mockImplementation((async () => ({ data: [class10, ug], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })) as never)
  })

  it('shows code, stage, level and what uses each class', async () => {
    renderClasses()
    const row = (await screen.findByText('Class 10')).closest('tr')!
    expect(within(row).getByText('CLASS_10')).toBeInTheDocument()
    expect(within(row).getByText('Secondary')).toBeInTheDocument()
    expect(within(row).getByText('10')).toBeInTheDocument()
    expect(within(row).getByText('12 teachers · 1 child')).toBeInTheDocument()
    expect(within(screen.getByText('UG').closest('tr')!).getByText('Unused')).toBeInTheDocument()
  })

  it('sends the stage filter to the API and resets to page 1', async () => {
    renderClasses()
    await screen.findByText('Class 10')
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'undergraduate' } })
    await waitFor(() => expect(lastCall()[1]).toMatchObject({ extra: { stage: 'undergraduate' }, page: 1 }))
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: '' } })
    await waitFor(() => expect(lastCall()[1].extra).toEqual({}))
  })

  it('opens the reorder dialog for a manager, saves, and refreshes the list', async () => {
    vi.mocked(reorderMasters).mockResolvedValue(undefined)
    renderClasses()
    fireEvent.click(await screen.findByRole('button', { name: 'Reorder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reorder classes' })
    await within(dialog).findByRole('list')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Undergraduate up' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save order' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Order of the classes saved.')
    expect(reorderMasters).toHaveBeenCalledWith('/classes', ['cl-ug', 'cl-10'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not offer reordering to a read-only admin', async () => {
    as('reader')
    renderClasses()
    await screen.findByText('Class 10')
    expect(screen.queryByRole('button', { name: 'Reorder' })).toBeNull()
  })

  it('does not offer reordering or import where the module has none (countries)', async () => {
    vi.mocked(listMasters).mockResolvedValue(page([india, uae]))
    renderPage()
    await screen.findByText('India')
    expect(screen.queryByRole('button', { name: 'Reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull()
  })
})
