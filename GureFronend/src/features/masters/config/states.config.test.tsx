import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, fetchOptions, importMasters, listMasters, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { stateFormSchema, statesConfig } from './states.config'
import type { StateRow } from './states.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { countryId: 'c-in', name: 'Kerala', code: 'KL', type: 'state' as const, sortOrder: 13, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const karnataka: StateRow = { ...base, id: 's-ka', country: { id: 'c-in', name: 'India' }, countryId: 'c-in', name: 'Karnataka', code: 'KA', type: 'state', sortOrder: 1, isActive: true, cityCount: 214 }
const ladakh: StateRow = { ...karnataka, id: 's-la', name: 'Ladakh', code: 'LA', type: 'union_territory', sortOrder: 2, cityCount: 0 }
const countries = [
  { value: 'c-in', label: 'India' },
  { value: 'c-ae', label: 'United Arab Emirates' },
]

const messages = (input: object) => {
  const result = stateFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
  vi.mocked(fetchOptions).mockResolvedValue(countries)
})

describe('stateFormSchema', () => {
  it('accepts a valid state, a lower-case code and a union territory', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, code: 'kl', type: 'union_territory' })).toEqual([])
  })

  it.each([
    [{ countryId: '' }, 'countryId: Pick an active parent record.'],
    [{ name: 'K' }, 'name: State name must be 2–60 characters.'],
    [{ code: '' }, 'code: Code uses 1–5 letters or digits.'],
    [{ code: 'KERALA' }, 'code: Code uses 1–5 letters or digits.'],
    [{ code: 'K-L' }, 'code: Code uses 1–5 letters or digits.'],
    [{ type: 'territory' }, 'type: Pick a value from the list.'],
    [{ sortOrder: 10000 }, 'sortOrder: Order must be 0–9,999.'],
    [{ sortOrder: Number.NaN }, 'sortOrder: Order must be a number.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('statesConfig', () => {
  it('sends the code upper-cased, the name trimmed and the country id', () => {
    expect(statesConfig.toPayload({ ...valid, name: ' Kerala ', code: ' kl ' })).toEqual({ countryId: 'c-in', name: 'Kerala', code: 'KL', type: 'state', sortOrder: 13, isActive: true })
  })

  it.each([
    [0, 'Unused'],
    [1, '1 city'],
    [214, '214 cities'],
  ])('describes %i cities', (cityCount, label) => {
    expect(statesConfig.usage({ ...karnataka, cityCount })).toEqual({ count: cityCount, label })
  })

  it('keeps the country selectable even when it is no longer an active option', () => {
    expect(statesConfig.selectedOption?.(karnataka, 'countryId')).toEqual({ value: 'c-in', label: 'India' })
    expect(statesConfig.selectedOption?.(karnataka, 'name')).toBeNull()
  })

  it('locks the country only once the state has cities', () => {
    expect(statesConfig.rowRules?.lockedFields?.(karnataka)).toEqual(['countryId'])
    expect(statesConfig.rowRules?.lockedFields?.(ladakh)).toEqual([])
  })

  it('is set up for CSV import', () => {
    expect(statesConfig.importCsv?.columns).toBe('country_iso2,name,code,type')
  })
})

describe('states list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [karnataka, ladakh], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })
  const lastParams = () => vi.mocked(listMasters).mock.calls.at(-1)![1]

  it('shows the country, code, type badge and city count', async () => {
    withClient(<MasterListPage config={statesConfig} />)
    const ka = (await screen.findByText('Karnataka')).closest('tr')!
    expect(within(ka).getByText('India')).toBeInTheDocument()
    expect(within(ka).getByText('KA')).toBeInTheDocument()
    expect(within(ka).getByText('214 cities')).toBeInTheDocument()
    expect(within(ka).queryByText('Union territory')).toBeNull()
    const la = screen.getByText('Ladakh').closest('tr')!
    expect(within(la).getByText('Union territory')).toBeInTheDocument()
    expect(within(la).getByText('Unused')).toBeInTheDocument()
  })

  it('filters by country (options from the countries list) and by type', async () => {
    withClient(<MasterListPage config={statesConfig} />)
    await screen.findByText('Karnataka')
    await screen.findByRole('option', { name: 'India' })
    expect(fetchOptions).toHaveBeenCalledWith('/countries', 'id')

    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'c-in' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ extra: { countryId: 'c-in' }, page: 1 }))
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'union_territory' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ extra: { countryId: 'c-in', type: 'union_territory' } }))
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: '' } })
    await waitFor(() => expect(lastParams().extra).toEqual({ type: 'union_territory' }))
  })

  it('imports a CSV from the page and reports what happened', async () => {
    vi.mocked(importMasters)
      .mockResolvedValueOnce({ dryRun: true, total: 2, created: [{ row: 2, label: 'Kerala (KL)' }], skipped: [{ row: 3, label: 'Goa (GA)', reason: 'A state with this name already exists.' }] })
      .mockResolvedValueOnce({ dryRun: false, total: 2, created: [{ row: 2, label: 'Kerala (KL)' }], skipped: [{ row: 3, label: 'Goa (GA)', reason: 'A state with this name already exists.' }] })
    withClient(<MasterListPage config={statesConfig} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import CSV' }))
    const dialog = screen.getByRole('dialog', { name: 'Import states from CSV' })
    fireEvent.change(within(dialog).getByLabelText('Or paste the rows'), { target: { value: 'country_iso2,name,code,type\nIN,Kerala,KL,state\nIN,Goa,GA,state' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 states' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Imported 1 states, skipped 1.')
  })

  it('hides Import CSV from a read-only admin', async () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'locations.read' })
    withClient(<MasterListPage config={statesConfig} />)
    await screen.findByText('Karnataka')
    expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull()
  })
})

describe('state form', () => {
  const open = (row: StateRow | null) => withClient(<MasterFormDrawer config={statesConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('fills the country select from the active countries and creates a state', async () => {
    vi.mocked(createMaster).mockResolvedValue(karnataka)
    open(null)
    await screen.findByRole('option', { name: 'United Arab Emirates' })
    expect(screen.getByLabelText('Type')).toHaveValue('state')

    fireEvent.click(screen.getByRole('button', { name: 'Add state' }))
    expect(await screen.findByText('Pick an active parent record.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()

    type('Country', 'c-in')
    type('State name', 'Kerala')
    type('Code', 'kl')
    type('Type', 'union_territory')
    fireEvent.click(screen.getByRole('button', { name: 'Add state' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/states', { countryId: 'c-in', name: 'Kerala', code: 'KL', type: 'union_territory', sortOrder: 0, isActive: true })
  })

  it('locks the country of a state that has cities and explains why', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...karnataka, name: 'Karnataka State' } as never)
    open(karnataka)
    await screen.findByRole('option', { name: 'India' })
    expect(screen.getByLabelText('Country')).toBeDisabled()
    expect(screen.getByLabelText('Country')).toHaveValue('c-in')
    expect(screen.getByText(/has cities, so it can’t move to another country/)).toBeInTheDocument()

    type('State name', 'Karnataka State')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/states', 's-ka', { name: 'Karnataka State' }, '2026-09-20T08:11:02.114Z'))
  })

  it('lets a state without cities change country, and shows an inactive current country', async () => {
    vi.mocked(fetchOptions).mockResolvedValue([{ value: 'c-ae', label: 'United Arab Emirates' }]) // India is no longer active
    vi.mocked(updateMaster).mockResolvedValue({ ...ladakh, countryId: 'c-ae' } as never)
    open(ladakh)
    expect(screen.getByLabelText('Country')).toBeEnabled()
    await screen.findByRole('option', { name: 'United Arab Emirates' })
    expect(screen.getByRole('option', { name: 'India' })).toBeInTheDocument()
    expect(screen.getByLabelText('Country')).toHaveValue('c-in')

    type('Country', 'c-ae')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/states', 's-la', { countryId: 'c-ae' }, '2026-09-20T08:11:02.114Z'))
  })
})
