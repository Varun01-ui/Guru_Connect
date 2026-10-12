import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchSettings, saveSettings } from '../api/settings.api'
import { groups, maintenance, supportEmail } from '../testData'
import { GlobalSettingsPage } from './GlobalSettingsPage'

vi.mock('../api/settings.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canUpdate: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'settings.read' || (canUpdate && key === 'settings.update') })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GlobalSettingsPage />
    </QueryClientProvider>,
  )

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(fetchSettings).mockResolvedValue({ groups: groups() })
})

describe('GlobalSettingsPage', () => {
  it('shows a loading state', () => {
    vi.mocked(fetchSettings).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading settings…')).toBeInTheDocument()
  })

  it('shows the error with a way to try again', async () => {
    vi.mocked(fetchSettings).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument()
  })

  it('has a tab per group and opens on the first one', async () => {
    show()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'Contact', 'Legal', 'App versions', 'Limits'])
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Platform name')).toBeInTheDocument()
  })

  it('switches tabs', async () => {
    show()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contact' }))
    expect(screen.getByLabelText('Support email')).toHaveValue('support@guruconnect.in')
    expect(screen.queryByLabelText('Platform name')).toBeNull()
  })

  it('filters the open tab by label or key', async () => {
    show()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contact' }))
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'contact.support_ph' } })
    expect(screen.getByLabelText('Support phone')).toBeInTheDocument()
    expect(screen.queryByLabelText('Support email')).toBeNull()
  })

  it('warns when maintenance mode is on', async () => {
    vi.mocked(fetchSettings).mockResolvedValue({ groups: groups({ app_versions: [{ ...maintenance, value: true }] }) })
    show()
    expect(await screen.findByRole('status')).toHaveTextContent('Maintenance mode is on.')
  })

  it('does not warn when maintenance mode is off', async () => {
    show()
    await screen.findByRole('tab', { name: 'General' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('is read-only for someone without settings.update', async () => {
    as(false)
    show()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contact' }))
    expect(screen.getByText('You can view these settings but not change them.')).toBeInTheDocument()
    expect(screen.getByLabelText('Support email')).toBeDisabled()
  })

  it('saves a change and shows the saved value without another fetch', async () => {
    const updated = { ...supportEmail, value: 'help@guruconnect.in', updatedAt: '2026-10-10T10:00:00.000Z' }
    vi.mocked(saveSettings).mockResolvedValue({ updated: 1, group: { group: 'contact', settings: [updated] } })
    show()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contact' }))
    fireEvent.change(screen.getByLabelText('Support email'), { target: { value: 'help@guruconnect.in' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull())
    expect(screen.getByLabelText('Support email')).toHaveValue('help@guruconnect.in')
    expect(fetchSettings).toHaveBeenCalledTimes(1)
  })

  it('reloads the latest values after a stale-form conflict', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Settings changed since you opened this page. Reload.'))
    show()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contact' }))
    fireEvent.change(screen.getByLabelText('Support email'), { target: { value: 'help@guruconnect.in' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    vi.mocked(fetchSettings).mockResolvedValue({ groups: groups({ contact: [{ ...supportEmail, value: 'someone-else@guruconnect.in' }] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(screen.getByLabelText('Support email')).toHaveValue('someone-else@guruconnect.in'))
  })
})
