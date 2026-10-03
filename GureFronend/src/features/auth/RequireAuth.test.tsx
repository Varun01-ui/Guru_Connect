import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { authStore } from './authStore'
import { RequireAuth } from './RequireAuth'

vi.mock('../../lib/api', () => ({ refreshSession: vi.fn().mockResolvedValue(false) }))
vi.mock('./api/auth.api', () => ({ fetchMe: vi.fn() }))

describe('RequireAuth', () => {
  it('redirects away from protected content when there is no session', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <RequireAuth>
          <div>Secret dashboard</div>
        </RequireAuth>
      </MemoryRouter>,
    )

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Secret dashboard')).not.toBeInTheDocument())
  })

  it('keeps the page and shows the session-ended dialog when the session expires mid-work', () => {
    authStore.setSession('token', { id: '1', email: 'a@b.co', fullName: 'A B', isSuperAdmin: false, avatarUrl: null })
    authStore.expire()

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <RequireAuth>
          <div>Unsaved work</div>
        </RequireAuth>
      </MemoryRouter>,
    )

    expect(screen.getByText('Unsaved work')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your session ended')
  })

  it('"Sign in again" goes to /login and remembers the route to return to', () => {
    authStore.setSession('token', { id: '1', email: 'a@b.co', fullName: 'A B', isSuperAdmin: false, avatarUrl: null })
    authStore.expire()

    function Login() {
      const { state } = useLocation() as { state?: { from?: { pathname: string } } }
      return <div>Login screen, return to {state?.from?.pathname}</div>
    }

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Routes>
          <Route
            path="/orders"
            element={
              <RequireAuth>
                <div>Unsaved work</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(screen.getByText('Login screen, return to /orders')).toBeInTheDocument()
    expect(authStore.getState().status).toBe('anonymous')
  })
})
