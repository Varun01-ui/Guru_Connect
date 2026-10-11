import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { fetchScopedOptions, mergeMaster } from '../api/masters.api'
import { areasConfig } from '../config/areas.config'
import type { Area } from '../config/areas.config'
import { MergeDialog } from './MergeDialog'

vi.mock('../api/masters.api')

const koramangala: Area = {
  id: 'a-kor',
  name: 'Koramangala',
  slug: 'koramangala',
  city: { id: 'c-blr', name: 'Bengaluru' },
  cityId: 'c-blr',
  pincodes: ['560034'],
  latitude: null,
  longitude: null,
  isActive: true,
  sortOrder: 1,
  teacherCount: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T08:11:02.114Z',
  deletedAt: null,
}
const options = [
  { value: 'a-kor', label: 'Koramangala' },
  { value: 'a-hsr', label: 'HSR Layout' },
  { value: 'a-ind', label: 'Indiranagar' },
]

const onClose = vi.fn()
const onMerged = vi.fn()
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MergeDialog config={areasConfig} row={koramangala} onClose={onClose} onMerged={onMerged} />
    </QueryClientProvider>,
  )
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchScopedOptions).mockResolvedValue(options)
})

describe('MergeDialog', () => {
  it('warns what a merge does and offers only the other areas of the same city', async () => {
    show()
    expect(screen.getByRole('dialog', { name: 'Merge Koramangala' })).toHaveTextContent('this area is removed')
    await screen.findByRole('option', { name: 'HSR Layout' })
    expect(fetchScopedOptions).toHaveBeenCalledWith('/areas', { cityId: 'c-blr' })
    expect(screen.queryByRole('option', { name: 'Koramangala' })).toBeNull() // not into itself
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Select…', 'HSR Layout', 'Indiranagar'])
  })

  it('asks for a target before calling the API', async () => {
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    submit()
    expect(await screen.findByText('Pick the area to merge into.')).toBeInTheDocument()
    expect(mergeMaster).not.toHaveBeenCalled()
  })

  it('merges into the chosen area with the reason and reports how many records moved', async () => {
    vi.mocked(mergeMaster).mockResolvedValue({ moved: { teacher_locations: 3, parents: 2 } })
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    fireEvent.change(screen.getByLabelText('Merge into'), { target: { value: 'a-hsr' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: ' Same locality, spelt twice ' } })
    submit()
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith('HSR Layout', 5))
    expect(mergeMaster).toHaveBeenCalledWith('/areas', 'a-kor', 'intoAreaId', 'a-hsr', 'Same locality, spelt twice')
  })

  it('sends no reason when none is given', async () => {
    vi.mocked(mergeMaster).mockResolvedValue({ moved: {} })
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    fireEvent.change(screen.getByLabelText('Merge into'), { target: { value: 'a-ind' } })
    submit()
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith('Indiranagar', 0))
    expect(mergeMaster).toHaveBeenCalledWith('/areas', 'a-kor', 'intoAreaId', 'a-ind', undefined)
  })

  it('shows a problem with the target under the select', async () => {
    vi.mocked(mergeMaster).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Both areas must be in the same city.', [{ path: 'intoAreaId', message: 'Both areas must be in the same city.' }]))
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    fireEvent.change(screen.getByLabelText('Merge into'), { target: { value: 'a-hsr' } })
    submit()
    expect(await screen.findByText('Both areas must be in the same city.')).toBeInTheDocument()
    expect(onMerged).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
  })

  it('shows other failures as an alert', async () => {
    vi.mocked(mergeMaster).mockRejectedValue(new Error('network down'))
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    fireEvent.change(screen.getByLabelText('Merge into'), { target: { value: 'a-hsr' } })
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not merge this area. Try again.')
  })

  it('explains when the list of areas could not load', async () => {
    vi.mocked(fetchScopedOptions).mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'The server is unwell.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is unwell.')
  })

  it('closes on Cancel and on Escape', async () => {
    show()
    await screen.findByRole('option', { name: 'HSR Layout' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
