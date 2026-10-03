import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ForgotPasswordPage } from './ForgotPasswordPage'

vi.mock('../api/auth.api', () => ({ forgotPassword: vi.fn().mockResolvedValue({ message: 'ok' }) }))

describe('ForgotPasswordPage', () => {
  it('always shows the generic confirmation message after submitting', async () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    )

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sameer@gmail.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByText(/we've emailed a reset link/i)).toBeInTheDocument()
  })
})
