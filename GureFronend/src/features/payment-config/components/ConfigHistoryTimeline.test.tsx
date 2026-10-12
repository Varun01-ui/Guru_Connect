import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { fetchHistory } from '../api/paymentConfig.api'
import type { HistoryEntry } from '../api/paymentConfig.api'
import { ConfigHistoryTimeline } from './ConfigHistoryTimeline'

vi.mock('../api/paymentConfig.api')

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'h1',
  feeCode: 'PARENT_SUBSCRIPTION_YEARLY',
  action: 'published',
  versionId: 'v4',
  version: 4,
  oldValues: { amountPaise: 199900 },
  newValues: { amountPaise: 179900 },
  reason: 'Diwali offer',
  changedBy: { id: 'a1', name: 'Farah Khan' },
  createdAt: '2026-10-10T09:00:00.000Z',
  ...over,
})
const show = (feeCode?: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfigHistoryTimeline feeCode={feeCode} />
    </QueryClientProvider>,
  )

beforeEach(() => vi.resetAllMocks())

describe('ConfigHistoryTimeline', () => {
  it('shows a loading state', () => {
    vi.mocked(fetchHistory).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading history…')).toBeInTheDocument()
  })

  it('lists each change with the fee, version, price move, who and why', async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ data: [entry(), entry({ id: 'h2', action: 'activated', changedBy: null, reason: null, oldValues: null, newValues: { status: 'active' } })], nextCursor: null })
    show()
    expect(await screen.findByText(/Published · Parent membership · Yearly v4/)).toBeInTheDocument()
    expect(screen.getByText('₹1,999 → ₹1,799')).toBeInTheDocument()
    expect(screen.getByText(/Farah Khan · “Diwali offer”/)).toBeInTheDocument()
    expect(screen.getByText(/Went live/)).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
  })

  it('asks only for the one fee when given a fee code', async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ data: [entry()], nextCursor: null })
    show('PREMIUM_TEACHER')
    await screen.findByText(/Published/)
    expect(fetchHistory).toHaveBeenCalledWith({ cursor: undefined, feeCode: 'PREMIUM_TEACHER' })
  })

  it('loads more with the cursor until there is no more', async () => {
    vi.mocked(fetchHistory)
      .mockResolvedValueOnce({ data: [entry()], nextCursor: 'CUR1' })
      .mockResolvedValueOnce({ data: [entry({ id: 'h9', action: 'disabled', version: 2, reason: 'Older' })], nextCursor: null })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText(/Switched off · Parent membership · Yearly v2/)).toBeInTheDocument()
    expect(fetchHistory).toHaveBeenLastCalledWith({ cursor: 'CUR1', feeCode: undefined })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
  })

  it('says so when there is nothing yet', async () => {
    vi.mocked(fetchHistory).mockResolvedValue({ data: [], nextCursor: null })
    show()
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument()
  })

  it('shows the error and retries', async () => {
    vi.mocked(fetchHistory).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.')).mockResolvedValue({ data: [entry()], nextCursor: null })
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Published/)).toBeInTheDocument()
  })
})
