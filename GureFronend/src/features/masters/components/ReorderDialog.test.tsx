import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { listMasters, reorderMasters } from '../api/masters.api'
import { classesConfig } from '../config/classes.config'
import type { ClassRow } from '../config/classes.config'
import { ReorderDialog } from './ReorderDialog'

vi.mock('../api/masters.api')

const row = (id: string, name: string, levelOrder: number, isActive = true): ClassRow => ({
  id,
  name,
  code: name.toUpperCase().replace(/\W+/g, '_'),
  stage: 'primary',
  levelOrder,
  isActive,
  teacherCount: 0,
  childCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T08:11:02.114Z',
  deletedAt: null,
})
const rows = [row('a', 'Class 1', 1), row('b', 'Class 2', 2), row('c', 'Class 3', 3, false)]
const meta = (total: number) => ({ page: 1, pageSize: 100, total, totalPages: 1 })

const onClose = vi.fn()
const onSaved = vi.fn()

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReorderDialog config={classesConfig} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  )
}
const names = () => within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.querySelector('span.truncate')!.textContent)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listMasters).mockResolvedValue({ data: rows, meta: meta(3) })
  vi.mocked(reorderMasters).mockResolvedValue(undefined)
})

describe('ReorderDialog', () => {
  it('loads the classes in their current order, with the warning and inactive marker', async () => {
    open()
    expect(screen.getByText('Loading classes…')).toBeInTheDocument()
    await screen.findByRole('list')
    expect(names()).toEqual(['Class 1', 'Class 2', 'Class 3'])
    expect(listMasters).toHaveBeenCalledWith('/classes', { page: 1, pageSize: 100, sort: { key: 'levelOrder', dir: 'asc' } })
    expect(screen.getByText(/recommendations use this order/)).toBeInTheDocument()
    expect(within(screen.getAllByRole('listitem')[2]!).getByText('Inactive')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled()
  })

  it('moves a class with the arrow buttons and saves the new sequence', async () => {
    open()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: 'Move Class 3 up' }))
    expect(names()).toEqual(['Class 1', 'Class 3', 'Class 2'])
    fireEvent.click(screen.getByRole('button', { name: 'Move Class 1 down' }))
    expect(names()).toEqual(['Class 3', 'Class 1', 'Class 2'])

    fireEvent.click(screen.getByRole('button', { name: 'Save order' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(reorderMasters).toHaveBeenCalledWith('/classes', ['c', 'a', 'b'])
  })

  it('cannot move the first row up or the last row down', async () => {
    open()
    await screen.findByRole('list')
    expect(screen.getByRole('button', { name: 'Move Class 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Class 3 down' })).toBeDisabled()
  })

  it('reorders by dragging a row onto another', async () => {
    open()
    await screen.findByRole('list')
    const items = screen.getAllByRole('listitem')
    fireEvent.dragStart(items[0]!)
    fireEvent.dragOver(items[2]!)
    fireEvent.drop(items[2]!)
    expect(names()).toEqual(['Class 2', 'Class 3', 'Class 1'])
    expect(screen.getByRole('button', { name: 'Save order' })).toBeEnabled()
  })

  it('goes back to "nothing to save" when the order is restored', async () => {
    open()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: 'Move Class 2 down' }))
    expect(screen.getByRole('button', { name: 'Save order' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move Class 2 up' }))
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled()
  })

  it('shows the API error and keeps the dialog open', async () => {
    vi.mocked(reorderMasters).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Send every one of the classes, in the order you want.'))
    open()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: 'Move Class 2 up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Send every one of the classes')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save order' })).toBeEnabled()
  })

  it('explains when the list could not load', async () => {
    vi.mocked(listMasters).mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'The server is unwell.'))
    open()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is unwell.')
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled()
  })

  it('refuses to reorder more than 100 rows', async () => {
    vi.mocked(listMasters).mockResolvedValue({ data: rows, meta: meta(150) })
    open()
    expect(await screen.findByRole('alert')).toHaveTextContent('more than 100 classes')
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled()
  })

  it('closes on Cancel and on Escape', async () => {
    open()
    await screen.findByRole('list')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
