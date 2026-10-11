import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, fetchOptions, listMasters, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { boardFormSchema, boardsConfig } from './boards.config'
import type { Board } from './boards.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { name: 'Central Board of Secondary Education', shortName: 'CBSE', type: 'national', stateId: '', sortOrder: 1, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const cbse: Board = { ...base, id: 'b-cbse', name: 'Central Board of Secondary Education', shortName: 'CBSE', type: 'national', state: null, stateId: null, isActive: true, sortOrder: 1, usageCount: 5310 }
const kerala: Board = { ...cbse, id: 'b-kl', name: 'Kerala Board of Public Examinations', shortName: 'Kerala State Board', type: 'state', state: { id: 's-kl', name: 'Kerala' }, stateId: 's-kl', sortOrder: 6, usageCount: 0 }
const states = [
  { value: 's-kl', label: 'Kerala' },
  { value: 's-ka', label: 'Karnataka' },
]

const messages = (input: object) => {
  const result = boardFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const withClient = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
  vi.mocked(fetchOptions).mockResolvedValue(states)
})

describe('boardFormSchema', () => {
  it('accepts a national board without a state and a state board with one', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, type: 'state', stateId: 's-kl' })).toEqual([])
  })

  it.each([
    [{ name: 'ab' }, 'name: Full name must be 3–120 characters.'],
    [{ shortName: 'x' }, 'shortName: Short name must be 2–40 characters.'],
    [{ type: 'college' }, 'type: Pick a value from the list.'],
    [{ type: '' }, 'type: Pick a value from the list.'],
    [{ type: 'state', stateId: '' }, 'stateId: Pick the state for a state board.'],
    [{ sortOrder: 10000 }, 'sortOrder: Order must be 0–9,999.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('boardsConfig', () => {
  it('sends a state only for a state board', () => {
    expect(boardsConfig.toPayload({ ...valid, stateId: 's-kl' })).toMatchObject({ type: 'national', stateId: null })
    expect(boardsConfig.toPayload({ ...valid, type: 'state', stateId: 's-kl' })).toMatchObject({ type: 'state', stateId: 's-kl' })
  })

  it.each([
    [0, 'Unused'],
    [1, '1 record'],
    [5310, '5310 records'],
  ])('describes %i uses', (usageCount, label) => {
    expect(boardsConfig.usage({ ...cbse, usageCount })).toEqual({ count: usageCount, label })
  })

  it('keeps the current state selectable even if it is no longer active', () => {
    expect(boardsConfig.selectedOption?.(kerala, 'stateId')).toEqual({ value: 's-kl', label: 'Kerala' })
    expect(boardsConfig.selectedOption?.(cbse, 'stateId')).toBeNull()
  })
})

describe('boards list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [cbse, kerala], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })

  it('shows short name, full name, type, state and usage', async () => {
    withClient(<MasterListPage config={boardsConfig} />)
    const nat = (await screen.findByText('CBSE')).closest('tr')!
    expect(within(nat).getByText('Central Board of Secondary Education')).toBeInTheDocument()
    expect(within(nat).getByText('National')).toBeInTheDocument()
    expect(within(nat).getByText('5310 records')).toBeInTheDocument()
    const st = screen.getByText('Kerala State Board').closest('tr')!
    expect(within(st).getByText('State board')).toBeInTheDocument()
    expect(within(st).getByText('Kerala')).toBeInTheDocument()
    expect(within(st).getByText('Unused')).toBeInTheDocument()
  })

  it('filters by type and by state', async () => {
    withClient(<MasterListPage config={boardsConfig} />)
    await screen.findByText('CBSE')
    await screen.findByRole('option', { name: 'Kerala' })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'state' } })
    await waitFor(() => expect(vi.mocked(listMasters).mock.calls.at(-1)![1]).toMatchObject({ extra: { type: 'state' } }))
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 's-kl' } })
    await waitFor(() => expect(vi.mocked(listMasters).mock.calls.at(-1)![1]).toMatchObject({ extra: { type: 'state', stateId: 's-kl' } }))
  })
})

describe('board form', () => {
  const open = (row: Board | null) => withClient(<MasterFormDrawer config={boardsConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('asks for a state only when the type is "State board"', async () => {
    open(null)
    expect(screen.queryByLabelText('State')).toBeNull()
    type('Type', 'state')
    expect(await screen.findByLabelText('State')).toBeInTheDocument()
    await screen.findByRole('option', { name: 'Karnataka' })
    type('Type', 'national')
    expect(screen.queryByLabelText('State')).toBeNull()
  })

  it('requires the state for a state board, then creates it', async () => {
    vi.mocked(createMaster).mockResolvedValue(kerala)
    open(null)
    type('Full name', 'Kerala Board of Public Examinations')
    type('Short name', 'Kerala State Board')
    type('Type', 'state')
    await screen.findByRole('option', { name: 'Kerala' })
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }))
    expect(await screen.findByText('Pick the state for a state board.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()

    type('State', 's-kl')
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/boards', { name: 'Kerala Board of Public Examinations', shortName: 'Kerala State Board', type: 'state', stateId: 's-kl', sortOrder: 0, isActive: true })
  })

  it('clears the state in the PATCH when a state board becomes a national board', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...kerala, type: 'national', state: null, stateId: null } as never)
    open(kerala)
    await screen.findByRole('option', { name: 'Karnataka' })
    type('Type', 'national')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/boards', 'b-kl', { type: 'national', stateId: null }, '2026-09-20T08:11:02.114Z'))
  })
})
