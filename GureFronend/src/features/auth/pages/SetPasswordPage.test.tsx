import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { AcceptInvitePage } from './AcceptInvitePage'
import { ResetPasswordPage } from './ResetPasswordPage'

vi.mock('../api/auth.api', () => ({ validateResetToken: vi.fn(), resetPassword: vi.fn() }))

import { resetPassword, validateResetToken } from '../api/auth.api'

const GOOD = 'Maple!Lantern-2026'

function renderAt(page: 'reset' | 'invite', search = '?token=abc123') {
  return render(
    <MemoryRouter initialEntries={[`/${page === 'reset' ? 'reset-password' : 'accept-invite'}${search}`]}>
      {page === 'reset' ? <ResetPasswordPage /> : <AcceptInvitePage />}
    </MemoryRouter>,
  )
}

function fill(password: string, confirm = password, labels: [string, string] = ['New password', 'Confirm new password']) {
  fireEvent.change(screen.getByLabelText(labels[0]), { target: { value: password } })
  fireEvent.change(screen.getByLabelText(labels[1]), { target: { value: confirm } })
}

beforeEach(() => {
  vi.mocked(validateResetToken).mockReset().mockResolvedValue({ purpose: 'reset' })
  vi.mocked(resetPassword).mockReset().mockResolvedValue({ success: true })
})

describe('ResetPasswordPage', () => {
  it('shows a loading state while the link is checked', () => {
    vi.mocked(validateResetToken).mockReturnValue(new Promise(() => undefined))
    renderAt('reset')
    expect(screen.getByText('Checking your link…')).toBeInTheDocument()
  })

  it('shows the expired-link state when the token is invalid', async () => {
    vi.mocked(validateResetToken).mockRejectedValue(new ApiError(410, 'AUTH_LINK_EXPIRED', 'This link has expired.'))
    renderAt('reset')
    expect(await screen.findByText('This link has expired. Request a new one.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
  })

  it('shows the expired-link state without calling the API when there is no token', async () => {
    renderAt('reset', '')
    expect(await screen.findByText('This link has expired. Request a new one.')).toBeInTheDocument()
    expect(validateResetToken).not.toHaveBeenCalled()
  })

  it('validates the token from the URL and shows the reset form', async () => {
    renderAt('reset', '?token=abc123')
    expect(await screen.findByRole('heading', { name: 'Reset password' })).toBeInTheDocument()
    await screen.findByLabelText('New password')
    expect(validateResetToken).toHaveBeenCalledWith('abc123')
  })

  it('keeps the submit button disabled until the password meets the policy and both fields match', async () => {
    renderAt('reset')
    await screen.findByLabelText('New password')
    const submit = screen.getByRole('button', { name: 'Set new password' })
    expect(submit).toBeDisabled()

    fill('short')
    expect(submit).toBeDisabled()
    expect(screen.getAllByRole('listitem').some((li) => li.getAttribute('data-ok') === 'false')).toBe(true)

    fill(GOOD, 'different-value')
    expect(submit).toBeDisabled()
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument()

    fill(GOOD)
    expect(submit).toBeEnabled()
    expect(screen.getAllByRole('listitem').every((li) => li.getAttribute('data-ok') === 'true')).toBe(true)
  })

  it('submits the new password and shows the success state', async () => {
    renderAt('reset')
    await screen.findByLabelText('New password')
    fill(GOOD)
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText(/You've been signed out everywhere else/)).toBeInTheDocument()
    expect(resetPassword).toHaveBeenCalledWith('abc123', GOOD)
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('lists the server field-level messages when the API rejects the password', async () => {
    vi.mocked(resetPassword).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'Some fields need attention.', [
        { path: 'newPassword', message: "Password can't be your email." },
        { path: 'newPassword', message: 'That password is too common.' },
      ]),
    )
    renderAt('reset')
    await screen.findByLabelText('New password')
    fill(GOOD)
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Password can't be your email.")
    expect(alert).toHaveTextContent('That password is too common.')
  })

  it("shows the API's message for a non-field error and keeps the form usable", async () => {
    vi.mocked(resetPassword).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', "Choose a password you haven't used before."))
    renderAt('reset')
    await screen.findByLabelText('New password')
    fill(GOOD)
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Choose a password you haven't used before.")
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeEnabled()
  })

  it('falls back to the expired-link state if the link expires while the form is open', async () => {
    vi.mocked(resetPassword).mockRejectedValue(new ApiError(410, 'AUTH_LINK_EXPIRED', 'This link has expired. Request a new one.'))
    renderAt('reset')
    await screen.findByLabelText('New password')
    fill(GOOD)
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument())
  })
})

describe('AcceptInvitePage', () => {
  it('uses the "Set your password" wording and activates the account on submit', async () => {
    vi.mocked(validateResetToken).mockResolvedValue({ purpose: 'invite' })
    renderAt('invite', '?token=invite-token-1')

    expect(await screen.findByRole('heading', { name: 'Set your password' })).toBeInTheDocument()
    await screen.findByLabelText('Password')
    fill(GOOD, GOOD, ['Password', 'Confirm password'])
    fireEvent.click(screen.getByRole('button', { name: 'Set password & activate' }))

    expect(await screen.findByText('Your account is ready. Sign in with your new password.')).toBeInTheDocument()
    expect(resetPassword).toHaveBeenCalledWith('invite-token-1', GOOD)
  })

  it('shows the expired state for an invalid invite link', async () => {
    vi.mocked(validateResetToken).mockRejectedValue(new ApiError(410, 'AUTH_LINK_EXPIRED', 'expired'))
    renderAt('invite')
    expect(await screen.findByText('This link has expired. Request a new one.')).toBeInTheDocument()
  })
})
