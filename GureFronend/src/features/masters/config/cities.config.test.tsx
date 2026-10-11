import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, fetchOptions, listMasters, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { cityFormSchema, citiesConfig } from './cities.config'
import type { City } from './cities.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))
vi.mock('../../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../lib/api')>()), apiFetch: vi.fn() }))

const valid = { stateId: 's-kl', name: 'Kochi', slug: '', latitude: '9.931233', longitude: '76.267304', tier: '2', isServiceable: false, sortOrder: 3, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const bengaluru: City = { ...base, id: 'c-blr', name: 'Bengaluru', slug: 'bengaluru', state: { id: 's-ka', name: 'Karnataka' }, stateId: 's-ka', latitude: 12.97, longitude: 77.59, tier: 1, isServiceable: true, isActive: true, sortOrder: 1, areaCount: 6, verifiedTeachers: 3120 }
const kochi: City = { ...bengaluru, id: 'c-koc', name: 'Kochi', slug: 'kochi', state: { id: 's-kl', name: 'Kerala' }, stateId: 's-kl', latitude: null, longitude: null, tier: null, isServiceable: false, areaCount: 0, verifiedTeachers: 0 }
const states = [
  { value: 's-kl', label: 'Kerala' },
  { value: 's-ka', label: 'Karnataka' },
]

const messages = (input: object) => {
  const result = cityFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
  vi.mocked(fetchOptions).mockResolvedValue(states)
})

describe('cityFormSchema', () => {
  it('accepts a valid city, blank coordinates and a blank slug', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, latitude: '', longitude: '', tier: '', slug: '' })).toEqual([])
    expect(messages({ ...valid, slug: 'Kochi-City' })).toEqual([])
  })

  it.each([
    [{ stateId: '' }, 'stateId: Pick an active parent record.'],
    [{ name: 'K' }, 'name: City name must be 2–60 characters.'],
    [{ slug: 'bad slug' }, 'slug: Slug uses 2–60 letters, digits or hyphens.'],
    [{ slug: 'a' }, 'slug: Slug uses 2–60 letters, digits or hyphens.'],
    [{ latitude: '91' }, 'latitude: Latitude must be a number between -90 and 90.'],
    [{ latitude: 'north' }, 'latitude: Latitude must be a number between -90 and 90.'],
    [{ longitude: '-181' }, 'longitude: Longitude must be a number between -180 and 180.'],
    [{ tier: '4' }, 'tier: Tier is 1, 2 or 3.'],
    [{ sortOrder: 10000 }, 'sortOrder: Order must be 0–9,999.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('citiesConfig', () => {
  it('turns the text boxes into numbers, null and a lower-cased slug', () => {
    expect(citiesConfig.toPayload(valid)).toEqual({ stateId: 's-kl', name: 'Kochi', latitude: 9.931233, longitude: 76.267304, tier: 2, isServiceable: false, sortOrder: 3, isActive: true })
    expect(citiesConfig.toPayload({ ...valid, slug: ' Kochi-City ', latitude: '', longitude: ' ', tier: '' })).toMatchObject({ slug: 'kochi-city', latitude: null, longitude: null, tier: null })
  })

  it('shows missing coordinates as empty boxes', () => {
    expect(citiesConfig.toFormValues(kochi)).toMatchObject({ latitude: '', longitude: '', tier: '', slug: 'kochi' })
    expect(citiesConfig.toFormValues(bengaluru)).toMatchObject({ latitude: '12.97', longitude: '77.59', tier: '1' })
  })

  it('freezes the slug of a launch city only', () => {
    expect(citiesConfig.rowRules?.lockedFields?.(bengaluru)).toEqual(['slug'])
    expect(citiesConfig.rowRules?.lockedFields?.(kochi)).toEqual([])
  })

  it.each([
    [0, 'Unused'],
    [1, '1 area'],
    [6, '6 areas'],
  ])('describes %i areas', (areaCount, label) => {
    expect(citiesConfig.usage({ ...kochi, areaCount })).toEqual({ count: areaCount, label })
  })
})

describe('launching a city asks first (FR-9.S1)', () => {
  it('shows the counts and warns when there are fewer than 20 verified teachers', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ verifiedTeachers: 12, institutes: 3, parents: 40, students: 9, areas: 6 })
    const message = await citiesConfig.confirmSave!({ row: kochi, payload: { isServiceable: true } })
    expect(apiFetch).toHaveBeenCalledWith('/cities/c-koc/stats')
    expect(message).toContain('Kochi has 12 verified teachers, 3 institutes and 6 areas.')
    expect(message).toContain('fewer than 20 verified teachers')
    expect(message).toContain('slug can’t change')
  })

  it('does not warn when the city is well covered', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ verifiedTeachers: 3120, institutes: 40, parents: 0, students: 0, areas: 1 })
    const message = await citiesConfig.confirmSave!({ row: kochi, payload: { isServiceable: true } })
    expect(message).toContain('3120 verified teachers, 40 institutes and 1 area.')
    expect(message).not.toContain('fewer than 20')
  })

  it('has no stats to fetch for a city that does not exist yet', async () => {
    const message = await citiesConfig.confirmSave!({ row: null, payload: { name: 'Mysuru', isServiceable: true } })
    expect(apiFetch).not.toHaveBeenCalled()
    expect(message).toContain('Mysuru has 0 verified teachers')
  })

  it.each([
    ['launching is not part of the change', { row: kochi, payload: { sortOrder: 4 } }],
    ['switching it off', { row: bengaluru, payload: { isServiceable: false } }],
    ['it is already a launch city', { row: bengaluru, payload: { isServiceable: true } }],
  ])('stays quiet when %s', async (_label, args) => {
    expect(await citiesConfig.confirmSave!(args)).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('cities list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [bengaluru, kochi], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })

  it('shows slug, state, tier, launch status and teachers', async () => {
    withClient(<MasterListPage config={citiesConfig} />)
    const blr = (await screen.findByText('Bengaluru')).closest('tr')!
    expect(within(blr).getByText('bengaluru')).toBeInTheDocument()
    expect(within(blr).getByText('Karnataka')).toBeInTheDocument()
    expect(within(blr).getByText('Tier 1')).toBeInTheDocument()
    expect(within(blr).getByText('Launch city')).toBeInTheDocument()
    expect(within(blr).getByText('3120')).toBeInTheDocument()
    expect(within(blr).getByText('6 areas')).toBeInTheDocument()
    const koc = screen.getByText('Kochi').closest('tr')!
    expect(within(koc).getByText('Not launched')).toBeInTheDocument()
    expect(within(koc).getByText('—')).toBeInTheDocument()
  })

  it('filters by country, state, tier and launch status', async () => {
    withClient(<MasterListPage config={citiesConfig} />)
    await screen.findByText('Bengaluru')
    await screen.findAllByRole('option', { name: 'Kerala' })
    const last = () => vi.mocked(listMasters).mock.calls.at(-1)![1]
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 's-kl' } })
    await waitFor(() => expect(last().extra).toMatchObject({ countryId: 's-kl' }))
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 's-ka' } })
    fireEvent.change(screen.getByLabelText('Tier'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Launch'), { target: { value: 'true' } })
    await waitFor(() => expect(last().extra).toEqual({ countryId: 's-kl', stateId: 's-ka', tier: '2', serviceable: 'true' }))
  })
})

describe('city form', () => {
  const open = (row: City | null) => withClient(<MasterFormDrawer config={citiesConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('creates a city without a slug and lets the API make one', async () => {
    vi.mocked(createMaster).mockResolvedValue(kochi)
    open(null)
    await screen.findByRole('option', { name: 'Kerala' })
    type('State', 's-kl')
    type('City name', 'Kochi')
    type('Latitude', '9.931233')
    type('Market tier', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Add city' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/cities', { stateId: 's-kl', name: 'Kochi', latitude: 9.931233, longitude: null, tier: 2, isServiceable: false, sortOrder: 0, isActive: true })
  })

  it('shows what is wrong with a coordinate before calling the API', async () => {
    open(null)
    type('City name', 'Kochi')
    type('Latitude', '123')
    fireEvent.click(screen.getByRole('button', { name: 'Add city' }))
    expect(await screen.findByText('Latitude must be a number between -90 and 90.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('asks before launching a new city, and only saves after "Yes, continue"', async () => {
    vi.mocked(createMaster).mockResolvedValue({ ...kochi, isServiceable: true } as never)
    open(null)
    await screen.findByRole('option', { name: 'Kerala' })
    type('State', 's-kl')
    type('City name', 'Kochi')
    fireEvent.click(screen.getByRole('switch', { name: 'Launch city' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add city' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Kochi has 0 verified teachers')
    expect(createMaster).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, continue' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalledWith('/cities', expect.objectContaining({ name: 'Kochi', isServiceable: true })))
  })

  it('keeps the form open and saves nothing when the launch is not confirmed', async () => {
    open(null)
    await screen.findByRole('option', { name: 'Kerala' })
    type('State', 's-kl')
    type('City name', 'Kochi')
    fireEvent.click(screen.getByRole('switch', { name: 'Launch city' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add city' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Add city' })).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('shows the live numbers before launching an existing city', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ verifiedTeachers: 25, institutes: 4, parents: 0, students: 0, areas: 8 })
    vi.mocked(updateMaster).mockResolvedValue({ ...kochi, isServiceable: true } as never)
    open(kochi)
    fireEvent.click(screen.getByRole('switch', { name: 'Launch city' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Kochi has 25 verified teachers, 4 institutes and 8 areas.')
    expect(dialog).not.toHaveTextContent('fewer than 20')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, continue' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/cities', 'c-koc', { isServiceable: true }, '2026-09-20T08:11:02.114Z'))
  })

  it('does not ask again for an ordinary edit of a launch city, and shows its slug as fixed', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...bengaluru, sortOrder: 4 } as never)
    open(bengaluru)
    expect(screen.getByLabelText('Slug')).toHaveAttribute('readonly')
    expect(screen.getByText(/slug can’t change, because links and SEO pages use it/)).toBeInTheDocument()
    type('Order', '4')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/cities', 'c-blr', { sortOrder: 4 }, '2026-09-20T08:11:02.114Z'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
