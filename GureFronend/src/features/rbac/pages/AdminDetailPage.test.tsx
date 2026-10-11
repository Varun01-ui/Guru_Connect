import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { authStore } from '../../auth/authStore'
import { usePermissions } from '../../auth/usePermissions'
import { deleteAdmin, disableAdmin, enableAdmin, fetchAdmin, fetchRole, fetchRoles, patchAdmin, resendInvite, revokeAllSessions } from '../api/rbac.api'
import { anjali, cityRole, roleSummaries, superRole, verificationRole } from '../testData'
import { AdminDetailPage } from './AdminDetailPage'

vi.mock('../api/rbac.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const me = { id: 'a-me', email: 'me@guruconnect.in', fullName: 'Me Myself', isSuperAdmin: true, avatarUrl: null }

function as(keys: string[]) {
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => keys.includes(key) })
}
function open(id = 'a-anjali') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/settings/admins/${id}`]}>
        <Routes>
          <Route path="/settings/admins" element={<div>Admins list page</div>} />
          <Route path="/settings/admins/:id" element={<AdminDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const FULL = ['admins.read', 'admins.manage', 'sessions.revoke_any']

beforeEach(() => {
  vi.resetAllMocks()
  authStore.setSession('token', me)
  as(FULL)
  vi.mocked(fetchAdmin).mockResolvedValue(anjali)
  vi.mocked(fetchRoles).mockResolvedValue(roleSummaries)
  vi.mocked(fetchRole).mockImplementation(async (id) => ({ 'r-verif': verificationRole, 'r-city': cityRole, 'r-super': superRole })[id]!)
})

describe('AdminDetailPage — what it shows', () => {
  it('shows the admin, status, roles, last sign-in and sessions', async () => {
    open()
    expect(await screen.findByRole('heading', { name: 'Anjali Menon' })).toBeInTheDocument()
    expect(screen.getByText('anjali@guruconnect.in')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Verification Admin' })).toHaveAttribute('href', '/settings/roles/r-verif')
    expect(screen.getByText('Active sessions').nextSibling).toHaveTextContent('2')
    expect(screen.getByText(/audit log viewer isn’t built yet/)).toBeInTheDocument()
  })

  it('shows when a pending invitation expires', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, status: 'invited', lastLoginAt: null, inviteExpiresAt: '2026-10-14T10:00:00.000Z' })
    open()
    expect(await screen.findByText('Invite expires')).toBeInTheDocument()
    expect(screen.getByText('Never')).toBeInTheDocument()
    expect(screen.getByText('Invited')).toBeInTheDocument()
  })

  it('marks a Super Admin', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, isSuperAdmin: true })
    open()
    expect(await screen.findByText('Super Admin')).toBeInTheDocument()
  })

  it('explains an admin that no longer exists', async () => {
    vi.mocked(fetchAdmin).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'This admin no longer exists.'))
    open('gone')
    expect(await screen.findByRole('alert')).toHaveTextContent('This admin no longer exists.')
    expect(screen.getByRole('link', { name: 'Back to admins' })).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    vi.mocked(fetchAdmin).mockReturnValue(new Promise(() => undefined))
    open()
    expect(screen.getByText('Loading admin…')).toBeInTheDocument()
  })
})

describe('AdminDetailPage — permissions', () => {
  it('gives a read-only admin no way to change anything', async () => {
    as(['admins.read'])
    open()
    await screen.findByRole('heading', { name: 'Anjali Menon' })
    for (const name of ['Edit name', 'Change roles', 'Disable', 'Delete', 'Enable', 'Resend invitation', 'Sign out everywhere']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('lets someone with only sessions.revoke_any sign the admin out', async () => {
    as(['admins.read', 'sessions.revoke_any'])
    open()
    await screen.findByRole('heading', { name: 'Anjali Menon' })
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  it('does not offer disable or delete on your own account', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, id: 'a-me' })
    open('a-me')
    await screen.findByRole('heading', { name: 'Anjali Menon' })
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.getByText(/your own account/)).toBeInTheDocument()
  })
})

describe('AdminDetailPage — actions', () => {
  it('edits the name', async () => {
    vi.mocked(patchAdmin).mockResolvedValue({ ...anjali, fullName: 'Anjali M. Menon' })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Anjali M. Menon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('heading', { name: 'Anjali M. Menon' })).toBeInTheDocument()
    expect(patchAdmin).toHaveBeenCalledWith('a-anjali', 'Anjali M. Menon', '2026-09-20T08:11:02.114Z')
    expect(screen.getByRole('status')).toHaveTextContent('Name saved.')
  })

  it('rejects a name that is too short without calling the API', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Name must be 2–100 characters.')).toBeInTheDocument()
    expect(patchAdmin).not.toHaveBeenCalled()
  })

  it('changes roles through the dialog and shows the result', async () => {
    const updated = { ...anjali, roles: [...anjali.roles, { id: 'r-city', code: 'city_launch_admin', name: 'City Launch Admin' }] }
    const { putAdminRoles } = await import('../api/rbac.api')
    vi.mocked(putAdminRoles).mockResolvedValue(updated)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Change roles' }))
    const dialog = await screen.findByRole('dialog', { name: 'Roles for Anjali Menon' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /City Launch Admin/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save roles' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Roles updated.')
    expect(screen.getByRole('link', { name: 'City Launch Admin' })).toBeInTheDocument()
  })

  it('disables the admin with a reason', async () => {
    vi.mocked(disableAdmin).mockResolvedValue({ ...anjali, status: 'disabled', sessionsCount: 0 })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Left the company' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    expect(await screen.findByText('Disabled')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Anjali Menon is disabled and signed out everywhere.')
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  it('enables a disabled admin again', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, status: 'disabled' })
    vi.mocked(enableAdmin).mockResolvedValue({ ...anjali, status: 'active' })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('can sign in again')
    expect(enableAdmin).toHaveBeenCalledWith('a-anjali')
  })

  it('deletes a disabled admin and goes back to the list', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, status: 'disabled' })
    vi.mocked(deleteAdmin).mockResolvedValue(undefined)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate account' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Admins list page')).toBeInTheDocument()
    expect(deleteAdmin).toHaveBeenCalledWith('a-anjali', 'Duplicate account')
  })

  it('resends the invitation of someone who has not joined yet', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, status: 'invited', inviteExpiresAt: '2026-10-14T10:00:00.000Z' })
    vi.mocked(resendInvite).mockResolvedValue({ id: 'a-anjali', email: 'anjali@guruconnect.in', status: 'invited', inviteExpiresAt: '2026-10-20T10:00:00.000Z' })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Resend invitation' }))
    expect(await screen.findByRole('status')).toHaveTextContent('A new invitation was sent to anjali@guruconnect.in.')
  })

  it('shows a failed action as an alert', async () => {
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, status: 'invited' })
    vi.mocked(resendInvite).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Please wait before trying again.'))
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Resend invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait before trying again.')
  })

  it('signs the admin out everywhere after confirmation', async () => {
    vi.mocked(revokeAllSessions).mockResolvedValue({})
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Sign Anjali Menon out everywhere?')
    vi.mocked(fetchAdmin).mockResolvedValue({ ...anjali, sessionsCount: 0 })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Signed out of every device.')
    expect(revokeAllSessions).toHaveBeenCalledWith('a-anjali')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull())
  })
})
