import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, fetchOptions, fetchScopedOptions, listMasters, mergeMaster, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { areaFormSchema, areasConfig } from './areas.config'
import type { Area } from './areas.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { cityId: 'c-blr', name: 'Koramangala', pincodes: '560034, 560095', latitude: '12.935242', longitude: '77.62448', sortOrder: 2, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const kor: Area = { ...base, id: 'a-kor', name: 'Koramangala', slug: 'koramangala', city: { id: 'c-blr', name: 'Bengaluru' }, cityId: 'c-blr', pincodes: ['560034', '560095'], latitude: 12.935242, longitude: 77.62448, isActive: true, sortOrder: 1, teacherCount: 214 }
const hsr: Area = { ...kor, id: 'a-hsr', name: 'HSR Layout', slug: 'hsr-layout', pincodes: [], latitude: null, longitude: null, teacherCount: 0 }
const cities = [
  { value: 'c-blr', label: 'Bengaluru' },
  { value: 'c-koc', label: 'Kochi' },
]

const messages = (input: object) => {
  const result = areaFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
  vi.mocked(fetchOptions).mockResolvedValue(cities)
  vi.mocked(fetchScopedOptions).mockResolvedValue([{ value: 'a-kor', label: 'Koramangala' }, { value: 'a-hsr', label: 'HSR Layout' }])
})

describe('areaFormSchema', () => {
  it('accepts a valid area, PINs separated by commas or spaces, and blank optional fields', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, pincodes: '560034 560095;560102|560103', latitude: '', longitude: '' })).toEqual([])
    expect(messages({ ...valid, pincodes: '' })).toEqual([])
  })

  it.each([
    [{ cityId: '' }, 'cityId: Pick an active parent record.'],
    [{ name: 'K' }, 'name: Area name must be 2–80 characters.'],
    [{ pincodes: '12345' }, 'pincodes: A PIN code is 6 digits and does not start with 0.'],
    [{ pincodes: '012345' }, 'pincodes: A PIN code is 6 digits and does not start with 0.'],
    [{ pincodes: '560034, 560034' }, 'pincodes: Each PIN code can only be listed once.'],
    [{ pincodes: Array.from({ length: 21 }, (_, i) => 560000 + i).join(' ') }, 'pincodes: An area can have up to 20 PIN codes.'],
    [{ latitude: '95' }, 'latitude: Latitude must be a number between -90 and 90.'],
    [{ longitude: 'east' }, 'longitude: Longitude must be a number between -180 and 180.'],
    [{ sortOrder: -1 }, 'sortOrder: Order must be 0–9,999.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('areasConfig', () => {
  it('turns the PIN box into a sorted list and the coordinate boxes into numbers', () => {
    expect(areasConfig.toPayload({ ...valid, pincodes: '560095  560034' })).toEqual({ cityId: 'c-blr', name: 'Koramangala', pincodes: ['560034', '560095'], latitude: 12.935242, longitude: 77.62448, sortOrder: 2, isActive: true })
    expect(areasConfig.toPayload({ ...valid, pincodes: '', latitude: '', longitude: ' ' })).toMatchObject({ pincodes: [], latitude: null, longitude: null })
  })

  it('shows the PIN codes and missing coordinates as text', () => {
    expect(areasConfig.toFormValues(kor)).toMatchObject({ pincodes: '560034, 560095', latitude: '12.935242' })
    expect(areasConfig.toFormValues(hsr)).toMatchObject({ pincodes: '', latitude: '', longitude: '' })
  })

  it('limits a merge to the same city, and supports a CSV import that can skip bad rows', () => {
    expect(areasConfig.merge?.scope?.(kor)).toEqual({ cityId: 'c-blr' })
    expect(areasConfig.merge?.targetKey).toBe('intoAreaId')
    expect(areasConfig.importCsv?.allowSkipInvalid).toBe(true)
  })

  it.each([
    [0, 'Unused'],
    [1, '1 teacher'],
    [214, '214 teachers'],
  ])('describes %i teachers', (teacherCount, label) => {
    expect(areasConfig.usage({ ...kor, teacherCount })).toEqual({ count: teacherCount, label })
  })
})

describe('areas list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [kor, hsr], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })

  it('shows slug, city, PIN codes and teachers', async () => {
    withClient(<MasterListPage config={areasConfig} />)
    const row = (await screen.findByText('Koramangala')).closest('tr')!
    expect(within(row).getByText('koramangala')).toBeInTheDocument()
    expect(within(row).getByText('Bengaluru')).toBeInTheDocument()
    expect(within(row).getByText('560034, 560095')).toBeInTheDocument()
    expect(within(row).getByText('214 teachers')).toBeInTheDocument()
    expect(within(screen.getByText('HSR Layout').closest('tr')!).getByText('—')).toBeInTheDocument()
  })

  it('filters by city and by whether the map position is known', async () => {
    withClient(<MasterListPage config={areasConfig} />)
    await screen.findByText('Koramangala')
    await screen.findByRole('option', { name: 'Kochi' })
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'c-koc' } })
    await waitFor(() => expect(vi.mocked(listMasters).mock.calls.at(-1)![1].extra).toEqual({ cityId: 'c-koc' }))
    fireEvent.change(screen.getByLabelText('Map position'), { target: { value: 'false' } })
    await waitFor(() => expect(vi.mocked(listMasters).mock.calls.at(-1)![1].extra).toEqual({ cityId: 'c-koc', hasCoordinates: 'false' }))
  })

  it('merges an area from its row and reports the result', async () => {
    vi.mocked(mergeMaster).mockResolvedValue({ moved: { teacher_locations: 3, parents: 1 } })
    withClient(<MasterListPage config={areasConfig} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge Koramangala' }))
    const dialog = await screen.findByRole('dialog', { name: 'Merge Koramangala' })
    await within(dialog).findByRole('option', { name: 'HSR Layout' })
    fireEvent.change(within(dialog).getByLabelText('Merge into'), { target: { value: 'a-hsr' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Merged Koramangala into HSR Layout. 4 records moved.')
    expect(mergeMaster).toHaveBeenCalledWith('/areas', 'a-kor', 'intoAreaId', 'a-hsr', undefined)
  })

  it('offers Merge only to someone who can manage, and not on modules without it', async () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'locations.read' })
    withClient(<MasterListPage config={areasConfig} />)
    await screen.findByText('Koramangala')
    expect(screen.queryByRole('button', { name: 'Merge Koramangala' })).toBeNull()
  })
})

describe('area form', () => {
  const open = (row: Area | null) => withClient(<MasterFormDrawer config={areasConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('creates an area with a PIN list', async () => {
    vi.mocked(createMaster).mockResolvedValue(kor)
    open(null)
    await screen.findByRole('option', { name: 'Kochi' })
    type('City', 'c-blr')
    type('Area name', 'Koramangala')
    type('PIN codes', '560095 560034')
    fireEvent.click(screen.getByRole('button', { name: 'Add area' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/areas', { cityId: 'c-blr', name: 'Koramangala', pincodes: ['560034', '560095'], latitude: null, longitude: null, sortOrder: 0, isActive: true })
  })

  it('rejects a bad PIN code before calling the API', async () => {
    open(null)
    type('Area name', 'Koramangala')
    type('PIN codes', '56003')
    fireEvent.click(screen.getByRole('button', { name: 'Add area' }))
    expect(await screen.findByText('A PIN code is 6 digits and does not start with 0.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('sends only the PIN list when only that changed', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...kor, pincodes: ['560034'] } as never)
    open(kor)
    type('PIN codes', '560034')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/areas', 'a-kor', { pincodes: ['560034'] }, '2026-09-20T08:11:02.114Z'))
  })

  it('treats the same PIN codes typed in another order as no change', async () => {
    const onClose = vi.fn()
    withClient(<MasterFormDrawer config={areasConfig} row={kor} onClose={onClose} onSaved={vi.fn()} />)
    type('PIN codes', '560095,560034')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateMaster).not.toHaveBeenCalled()
  })
})
