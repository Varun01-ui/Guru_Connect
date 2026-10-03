import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import type { AdminSession } from '../api/auth.api'
import { SessionsPage } from './SessionsPage'

vi.mock('../api/auth.api', () => ({ fetchSessions: vi.fn(), revokeSession: vi.fn() }))

import { fetchSessions, revokeSession } from '../api/auth.api'

const current: AdminSession = {
  id: 's-current',
  deviceLabel: 'Chrome on Windows',
  ipAddress: '103.21.4.9',
  lastUsedAt: '2026-09-26T10:58:00Z',
  createdAt: '2026-09-22T04:10:00Z',
  isCurrent: true,
}
const phone: AdminSession = { ...current, id: 's-phone', deviceLabel: 'Safari on iOS', ipAddress: '49.36.1.2', isCurrent: false }
const laptop: AdminSession = { ...current, id: 's-laptop', deviceLabel: 'Firefox on Linux', ipAddress: null, isCurrent: false }

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SessionsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(fetchSessions).mockReset()
  vi.mocked(revokeSession).mockReset().mockResolvedValue(undefined)
})

describe('SessionsPage', () => {
  it('shows a loading state', () => {
    vi.mocked(fetchSessions).mockReturnValue(new Promise(() => undefined))
    renderPage()
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument()
  })

  it('lists sessions, badges this device and gives it no sign-out button', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([current, phone])
    renderPage()

    const currentRow = (await screen.findByText('Chrome on Windows')).closest('tr')!
    expect(within(currentRow).getByText('This device')).toBeInTheDocument()
    expect(within(currentRow).queryByRole('button')).toBeNull()

    const phoneRow = screen.getByText('Safari on iOS').closest('tr')!
    expect(within(phoneRow).getByText('49.36.1.2')).toBeInTheDocument()
    expect(within(phoneRow).getByRole('button', { name: 'Sign out Safari on iOS' })).toBeInTheDocument()
  })

  it('shows a dash for a missing IP address', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([current, laptop])
    renderPage()
    const row = (await screen.findByText('Firefox on Linux')).closest('tr')!
    expect(within(row).getByText('—')).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out other devices' })).toBeDisabled()
  })

  it('shows the error and retries', async () => {
    vi.mocked(fetchSessions).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    vi.mocked(fetchSessions).mockResolvedValueOnce([current])
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument()
    expect(fetchSessions).toHaveBeenCalledTimes(2)
  })

  it('signs out one device and refreshes the list', async () => {
    vi.mocked(fetchSessions).mockResolvedValueOnce([current, phone])
    vi.mocked(fetchSessions).mockResolvedValueOnce([current])
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }))

    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('s-phone'))
    await waitFor(() => expect(screen.queryByText('Safari on iOS')).not.toBeInTheDocument())
  })

  it('"Sign out other devices" revokes every session except the current one', async () => {
    vi.mocked(fetchSessions).mockResolvedValueOnce([current, phone, laptop])
    vi.mocked(fetchSessions).mockResolvedValueOnce([current])
    renderPage()

    await screen.findByText('Firefox on Linux') // the button stays disabled until the list has loaded
    const button = screen.getByRole('button', { name: 'Sign out other devices' })
    expect(button).toBeEnabled()
    fireEvent.click(button)

    await waitFor(() => expect(revokeSession).toHaveBeenCalledTimes(2))
    expect(revokeSession).toHaveBeenCalledWith('s-phone')
    expect(revokeSession).toHaveBeenCalledWith('s-laptop')
    expect(revokeSession).not.toHaveBeenCalledWith('s-current')
    await waitFor(() => expect(screen.queryByText('Firefox on Linux')).not.toBeInTheDocument())
  })

  it('disables "Sign out other devices" when this is the only session', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([current])
    renderPage()
    await screen.findByText('Chrome on Windows')
    expect(screen.getByRole('button', { name: 'Sign out other devices' })).toBeDisabled()
  })

  it('shows an error when signing a device out fails', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([current, phone])
    vi.mocked(revokeSession).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Session not found.'))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }))
    expect(await screen.findByText('Session not found.')).toBeInTheDocument()
  })
})
