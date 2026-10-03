import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { LoginPage } from './LoginPage'

vi.mock('../api/auth.api', () => ({
  loginWithPassword: vi.fn(),
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  fetchOtpLogs: vi.fn(),
}))

import { fetchOtpLogs, loginWithPassword, requestOtp } from '../api/auth.api'

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(loginWithPassword).mockReset()
  vi.mocked(requestOtp).mockReset()
  vi.mocked(fetchOtpLogs).mockReset()
})

describe('LoginPage', () => {
  it('shows the password form by default', () => {
    renderLogin()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('switches to the mobile OTP tab', () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Mobile OTP' }))
    expect(screen.getByLabelText('Mobile number')).toBeInTheDocument()
  })

  it('shows the dev OTP code on screen after requesting it, and fills the code from logs', async () => {
    vi.mocked(requestOtp).mockResolvedValue({ sent: true, devCode: '123456', expiresInSeconds: 300 })
    vi.mocked(fetchOtpLogs).mockResolvedValue([
      { id: '1', code: '123456', status: 'pending', attempts: 0, expiresAt: '', verifiedAt: null, createdAt: '' },
    ])

    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Mobile OTP' }))
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '+919999999999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))

    expect(await screen.findByText('123456')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Fill from OTP logs' }))

    const codeInput = (await screen.findByLabelText('6-digit code')) as HTMLInputElement
    await waitFor(() => expect(codeInput.value).toBe('123456'))
  })

  function submitPassword() {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  it('shows the API message for wrong credentials', async () => {
    vi.mocked(loginWithPassword).mockRejectedValue(new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.'))
    renderLogin()
    submitPassword()
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('shows the throttle message on RATE_LIMITED', async () => {
    vi.mocked(loginWithPassword).mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.'))
    renderLogin()
    submitPassword()
    expect(await screen.findByText('Too many attempts. Wait a minute and try again.')).toBeInTheDocument()
  })

  it('shows a live lockout countdown, links to password reset and disables sign-in while locked', async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString()
    vi.mocked(loginWithPassword).mockRejectedValue(new ApiError(423, 'AUTH_ACCOUNT_LOCKED', 'locked', { lockedUntil }))
    renderLogin()
    submitPassword()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Account locked after too many attempts/)
    expect(alert).toHaveTextContent(/1[45]:\d\d/)
    expect(within(alert).getByRole('link', { name: 'reset your password' })).toHaveAttribute('href', '/forgot-password')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })

  it('re-enables sign-in once the lock has passed', async () => {
    const lockedUntil = new Date(Date.now() - 5_000).toISOString()
    vi.mocked(loginWithPassword).mockRejectedValue(new ApiError(423, 'AUTH_ACCOUNT_LOCKED', 'locked', { lockedUntil }))
    renderLogin()
    submitPassword()

    expect(await screen.findByText(/Too many attempts\. Try again after/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('links to forgot-password', () => {
    renderLogin()
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
  })
})
