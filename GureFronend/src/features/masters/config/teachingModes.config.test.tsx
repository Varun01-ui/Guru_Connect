import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../../auth/usePermissions'
import { createMaster, listMasters, updateMaster } from '../api/masters.api'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { MasterListPage } from '../pages/MasterListPage'
import { teachingModeFormSchema, teachingModesConfig } from './teachingModes.config'
import type { TeachingMode } from './teachingModes.config'

vi.mock('../api/masters.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const valid = { name: 'Recorded course', code: 'RECORDED', description: 'Pre-recorded lessons', requiresLocation: false, sortOrder: 6, isActive: true }
const base = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T08:11:02.114Z', deletedAt: null }
const online: TeachingMode = { ...base, id: 'm-on', name: 'Online', code: 'ONLINE', description: 'Live video classes', requiresLocation: false, sortOrder: 1, isActive: true, isSystem: true, teacherCount: 12 }
const recorded: TeachingMode = { ...base, id: 'm-rec', name: 'Recorded course', code: 'RECORDED', description: null, requiresLocation: false, sortOrder: 6, isActive: true, isSystem: false, teacherCount: 0 }

const messages = (input: object) => {
  const result = teachingModeFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => true })
})

describe('teachingModeFormSchema', () => {
  it('accepts a valid mode, a lower-case code and a blank description', () => {
    expect(messages(valid)).toEqual([])
    expect(messages({ ...valid, code: 'recorded_live', description: '' })).toEqual([])
  })

  it.each([
    [{ name: 'A' }, 'name: Name must be 2–40 characters.'],
    [{ code: 'AB' }, 'code: Code uses 3–30 letters or underscores.'],
    [{ code: 'MODE_2' }, 'code: Code uses 3–30 letters or underscores.'],
    [{ description: 'x'.repeat(201) }, 'description: Description can be up to 200 characters.'],
    [{ sortOrder: 10000 }, 'sortOrder: Order must be 0–9,999.'],
    [{ sortOrder: Number.NaN }, 'sortOrder: Order must be a number.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('teachingModesConfig', () => {
  it('sends a blank description as null and the code upper-cased', () => {
    expect(teachingModesConfig.toPayload({ ...valid, description: '   ', code: ' recorded ' })).toMatchObject({ description: null, code: 'RECORDED' })
    expect(teachingModesConfig.toPayload(valid)).toMatchObject({ description: 'Pre-recorded lessons' })
  })

  it('shows no description as an empty field', () => {
    expect(teachingModesConfig.toFormValues(recorded).description).toBe('')
  })

  it('locks the flags of a built-in mode and nothing on a custom one', () => {
    expect(teachingModesConfig.rowRules?.lockedFields?.(online)).toEqual(['requiresLocation', 'isActive'])
    expect(teachingModesConfig.rowRules?.lockedFields?.(recorded)).toEqual([])
    expect(teachingModesConfig.rowRules?.canDelete?.(online)).toBe(false)
    expect(teachingModesConfig.rowRules?.canToggle?.(online)).toBe(false)
    expect(teachingModesConfig.rowRules?.canDelete?.(recorded)).toBe(true)
  })

  it.each([
    [0, { count: 0, label: 'Unused' }],
    [1, { count: 1, label: '1 teacher' }],
    [5220, { count: 5220, label: '5220 teachers' }],
  ])('describes %i teachers', (teacherCount, expected) => {
    expect(teachingModesConfig.usage({ ...recorded, teacherCount })).toEqual(expected)
  })
})

describe('teaching modes list page', () => {
  beforeEach(() => {
    vi.mocked(listMasters).mockResolvedValue({ data: [online, recorded], meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 } })
  })

  it('marks built-in modes and withholds delete and the active switch from them', async () => {
    withClient(<MasterListPage config={teachingModesConfig} />)
    const builtIn = (await screen.findByText('Online')).closest('tr')!
    expect(within(builtIn).getByText('Built-in')).toBeInTheDocument()
    expect(within(builtIn).getByText('ONLINE')).toBeInTheDocument()
    expect(within(builtIn).getByText('12 teachers')).toBeInTheDocument()
    expect(within(builtIn).getByRole('switch', { name: 'Online active' })).toBeDisabled()
    expect(within(builtIn).getByRole('button', { name: 'Edit Online' })).toBeInTheDocument()
    expect(within(builtIn).queryByRole('button', { name: 'Delete Online' })).toBeNull()

    const custom = screen.getByText('Recorded course').closest('tr')!
    expect(within(custom).queryByText('Built-in')).toBeNull()
    expect(within(custom).getByRole('switch', { name: 'Recorded course active' })).toBeEnabled()
    expect(within(custom).getByRole('button', { name: 'Delete Recorded course' })).toBeInTheDocument()
    expect(within(custom).getByText('Unused')).toBeInTheDocument()
  })
})

describe('teaching mode form', () => {
  const open = (row: TeachingMode | null) => withClient(<MasterFormDrawer config={teachingModesConfig} row={row} onClose={vi.fn()} onSaved={vi.fn()} />)
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('creates a mode with a description and a location flag', async () => {
    vi.mocked(createMaster).mockResolvedValue(recorded)
    open(null)
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA')
    type('Name', 'Recorded course')
    type('Code', 'recorded')
    type('Description', ' Pre-recorded lessons ')
    fireEvent.click(screen.getByRole('switch', { name: 'Needs location' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add teaching mode' }))
    await waitFor(() => expect(createMaster).toHaveBeenCalled())
    expect(createMaster).toHaveBeenCalledWith('/teaching-modes', {
      name: 'Recorded course',
      code: 'RECORDED',
      description: 'Pre-recorded lessons',
      requiresLocation: false,
      sortOrder: 0,
      isActive: true,
    })
  })

  it('locks the code and, for a built-in mode, the two flags', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...online, name: 'Online classes' } as never)
    open(online)
    expect(screen.getByLabelText('Code')).toHaveAttribute('readonly')
    expect(screen.getByRole('switch', { name: 'Needs location' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Active' })).toBeDisabled()
    expect(screen.getByLabelText('Name')).toBeEnabled()

    type('Name', 'Online classes')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/teaching-modes', 'm-on', { name: 'Online classes' }, '2026-09-20T08:11:02.114Z'))
  })

  it('keeps the flags editable on a custom mode and clears a description with null', async () => {
    vi.mocked(updateMaster).mockResolvedValue({ ...recorded, description: null } as never)
    open({ ...recorded, description: 'Old text' })
    expect(screen.getByRole('switch', { name: 'Needs location' })).toBeEnabled()
    type('Description', '')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateMaster).toHaveBeenCalledWith('/teaching-modes', 'm-rec', { description: null }, '2026-09-20T08:11:02.114Z'))
  })
})
