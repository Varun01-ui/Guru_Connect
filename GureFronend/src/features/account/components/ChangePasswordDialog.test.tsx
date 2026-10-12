import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { authStore } from '../../auth/authStore'
import { changePassword } from '../api/account.api'
import { ChangePasswordDialog } from './ChangePasswordDialog'

vi.mock('../api/account.api')

const onClose = vi.fn()
const onChanged = vi.fn()
const GOOD = 'Quiet-River-Lamp-77'
const admin = { id: '1', email: 'anjali@guruconnect.in', fullName: 'Anjali Menon', isSuperAdmin: false, avatarUrl: null }
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
const fill = (current = 'Old-Password-1!', next = GOOD, confirm = next) => {
  type('Current password', current)
  type('New password', next)
  type('Confirm new password', confirm)
}

beforeEach(() => {
  vi.resetAllMocks()
  authStore.setSession('old-token', admin)
  render(<ChangePasswordDialog email={admin.email} fullName={admin.fullName} onClose={onClose} onChanged={onChanged} />)
})

describe('ChangePasswordDialog', () => {
  it('shows the requirements checklist and signs other devices out by default', () => {
    expect(screen.getByRole('list', { name: 'Password requirements' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Sign out of my other devices' })).toBeChecked()
  })

  it('ticks the checklist as the new password gets stronger', () => {
    type('New password', 'short')
    expect(screen.getByText('At least 12 characters').closest('li')).toHaveAttribute('data-ok', 'false')
    type('New password', GOOD)
    expect(screen.getByText('At least 12 characters').closest('li')).toHaveAttribute('data-ok', 'true')
  })

  it('shows every problem and sends nothing when the form is empty', async () => {
    submit()
    expect(await screen.findByText('Enter your current password.')).toBeInTheDocument()
    expect(screen.getByText('Your new password needs to meet every requirement below.')).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('needs the two new passwords to match', async () => {
    fill('Old-Password-1!', GOOD, GOOD + 'x')
    submit()
    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('refuses to reuse the current password', async () => {
    fill(GOOD, GOOD)
    submit()
    expect(await screen.findByText("Choose a password you haven't used before.")).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('changes the password, swaps in the new access token and reports how many devices were signed out', async () => {
    vi.mocked(changePassword).mockResolvedValue({ accessToken: 'new-token', expiresIn: 900, sessionsRevoked: 2 })
    fill()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sign out of my other devices' }))
    submit()
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ sessionsRevoked: 2 }))
    expect(changePassword).toHaveBeenCalledWith({ currentPassword: 'Old-Password-1!', newPassword: GOOD, signOutOtherSessions: false })
    expect(authStore.getState().accessToken).toBe('new-token')
    expect(authStore.getState().admin).toEqual(admin)
  })

  it('shows a wrong current password next to that field', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Your current password is incorrect.'))
    fill()
    submit()
    const alert = await screen.findByText('Your current password is incorrect.')
    expect(alert.closest('div')).toContainElement(screen.getByLabelText('Current password'))
    expect(onChanged).not.toHaveBeenCalled()
    expect(authStore.getState().accessToken).toBe('old-token')
  })

  it('shows the server’s policy messages next to the new password', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'That password is too common.', [{ path: 'newPassword', message: 'That password is too common.' }]))
    fill()
    submit()
    expect(await screen.findByText('That password is too common.')).toBeInTheDocument()
  })

  it('shows a locked account as a message for the whole dialog', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(423, 'AUTH_ACCOUNT_LOCKED', 'Too many attempts. Try again after 4:15 pm.'))
    fill()
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again after 4:15 pm.')
  })

  it('closes from Cancel', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
