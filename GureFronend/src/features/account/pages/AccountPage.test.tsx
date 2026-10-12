import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { fetchProfile, patchProfile } from '../api/account.api'
import { profile } from '../testData'
import { AccountPage } from './AccountPage'

vi.mock('../api/account.api')
// Heavy children have their own tests; the page test is about loading, saving with versions and conflicts.
vi.mock('../components/AvatarUploader', () => ({ AvatarUploader: () => <div>avatar uploader</div> }))
vi.mock('../components/ChangePasswordDialog', () => ({
  ChangePasswordDialog: ({ onChanged, onClose }: { onChanged: (r: { sessionsRevoked: number }) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Change password">
      <button onClick={() => onChanged({ sessionsRevoked: 2 })}>finish</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchProfile).mockResolvedValue(profile)
})

describe('AccountPage', () => {
  it('shows a loading state, then the sections', async () => {
    vi.mocked(fetchProfile).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading your account…')).toBeInTheDocument()
  })

  it('shows the error with a way to try again', async () => {
    vi.mocked(fetchProfile).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeInTheDocument()
  })

  it('shows the role, the profile, preferences, notifications and security sections', async () => {
    show()
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeInTheDocument()
    expect(screen.getByText(/Verification Admin/)).toBeInTheDocument()
    expect(screen.getByLabelText('Full name')).toHaveValue('Anjali Menon')
    for (const name of ['Profile', 'Preferences', 'Notifications', 'Security']) expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage signed-in devices' })).toHaveAttribute('href', '/account/security')
    expect(screen.getByText('avatar uploader')).toBeInTheDocument()
  })

  it('saves with the profile’s version and shows the saved profile; the next save carries the new version', async () => {
    const first = { ...profile, designation: 'Head of Verification', updatedAt: '2026-10-10T09:05:00.000Z' }
    vi.mocked(patchProfile).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, notificationPrefs: { ...first.notificationPrefs, queue_alerts: true }, updatedAt: '2026-10-10T09:06:00.000Z' })
    show()
    fireEvent.change(await screen.findByLabelText('Designation'), { target: { value: 'Head of Verification' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(patchProfile).toHaveBeenCalledWith({ designation: 'Head of Verification' }, profile.updatedAt))
    await waitFor(() => expect(screen.getAllByRole('status')[0]).toHaveTextContent('Saved'))

    fireEvent.click(screen.getByRole('switch', { name: 'Queue alerts' }))
    await waitFor(() => expect(patchProfile).toHaveBeenCalledTimes(2))
    expect(patchProfile).toHaveBeenLastCalledWith({ notificationPrefs: { queue_alerts: true } }, first.updatedAt)
  })

  it('offers to reload when the profile changed in another tab', async () => {
    vi.mocked(patchProfile).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Your profile changed in another tab. Reload.'))
    show()
    fireEvent.change(await screen.findByLabelText('Designation'), { target: { value: 'Head of Verification' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    const banner = await screen.findByText('Your profile changed in another tab. Reload.', { selector: 'span' })
    expect(banner).toBeInTheDocument()

    vi.mocked(fetchProfile).mockResolvedValue({ ...profile, designation: 'Set elsewhere', updatedAt: '2026-10-10T09:30:00.000Z' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(screen.getByLabelText('Designation')).toHaveValue('Set elsewhere'))
    expect(screen.queryByRole('button', { name: 'Reload latest' })).toBeNull()
  })

  it('opens the change-password dialog and confirms the result', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    fireEvent.click(screen.getByRole('button', { name: 'finish' }))
    expect(await screen.findByText(/Password changed\. 2 other devices were signed out\./)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('can close the change-password dialog without changing anything', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/Password changed/)).toBeNull()
  })
})
