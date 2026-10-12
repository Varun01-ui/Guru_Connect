import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { fetchSetting } from '../api/settings.api'
import { supportEmail } from '../testData'
import { SettingHistoryDrawer } from './SettingHistoryDrawer'

vi.mock('../api/settings.api')

const show = (onClose = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingHistoryDrawer settingKey="contact.support_email" label="Support email" onClose={onClose} />
    </QueryClientProvider>,
  )
  return onClose
}

beforeEach(() => vi.resetAllMocks())

describe('SettingHistoryDrawer', () => {
  it('shows a loading state first', () => {
    vi.mocked(fetchSetting).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading history…')).toBeInTheDocument()
  })

  it('lists each change with old and new value, who made it and why', async () => {
    vi.mocked(fetchSetting).mockResolvedValue({
      ...supportEmail,
      history: [
        { id: 'h2', action: 'setting.updated', actorEmail: 'sameer@guruconnect.in', oldValue: 'a@x.in', newValue: 'b@x.in', reason: 'New inbox', at: '2026-10-05T09:30:00.000Z' },
        { id: 'h1', action: 'setting.maintenance_enabled', actorEmail: null, oldValue: false, newValue: true, reason: null, at: '2026-10-01T09:30:00.000Z' },
      ],
    })
    show()
    expect(await screen.findByText('Changed')).toBeInTheDocument()
    expect(screen.getByText('a@x.in')).toBeInTheDocument()
    expect(screen.getByText('b@x.in')).toBeInTheDocument()
    expect(screen.getByText(/sameer@guruconnect.in · “New inbox”/)).toBeInTheDocument()
    expect(screen.getByText('Maintenance switched on')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(fetchSetting).toHaveBeenCalledWith('contact.support_email')
  })

  it('says so when nothing has changed yet', async () => {
    vi.mocked(fetchSetting).mockResolvedValue({ ...supportEmail, history: [] })
    show()
    expect(await screen.findByText('No changes recorded yet.')).toBeInTheDocument()
  })

  it('shows the error when the history cannot be loaded', async () => {
    vi.mocked(fetchSetting).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Setting not found.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Setting not found.')
  })

  it('closes from the Close button', async () => {
    vi.mocked(fetchSetting).mockResolvedValue({ ...supportEmail, history: [] })
    const onClose = show()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
