import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authStore } from '../features/auth/authStore'
import { usePermissions } from '../features/auth/usePermissions'
import { AppShell } from './AppShell'

vi.mock('../features/auth/api/auth.api', () => ({ logout: vi.fn() }))
vi.mock('../features/auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const admin = { id: '1', email: 'a@b.co', fullName: 'Asha Rao', isSuperAdmin: false, avatarUrl: null }

function renderShell(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <div>page body</div>
      </AppShell>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  authStore.setSession('t', admin)
})

describe('AppShell sidebar', () => {
  it('links to Countries for an admin who can read locations', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'locations.read' })
    renderShell()
    const link = screen.getByRole('link', { name: 'Countries' })
    expect(link).toHaveAttribute('href', '/masters/locations/countries')
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('page body')).toBeInTheDocument()
  })

  it('links to Classes only with the education masters permission', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'education_masters.read' })
    renderShell()
    expect(screen.getByRole('link', { name: 'Classes' })).toHaveAttribute('href', '/masters/education/classes')
    expect(screen.queryByRole('link', { name: 'Countries' })).toBeNull()
  })

  it('links every education master with the education masters permission', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'education_masters.read' })
    renderShell()
    expect(screen.getByRole('link', { name: 'Teaching modes' })).toHaveAttribute('href', '/masters/education/teaching-modes')
    expect(screen.getByRole('link', { name: 'Teacher categories' })).toHaveAttribute('href', '/masters/education/teacher-categories')
  })

  it('links to Roles and Admins under Settings with their permissions', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'roles.read' })
    renderShell()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute('href', '/settings/roles')
    expect(screen.queryByRole('link', { name: 'Admins' })).toBeNull()
  })

  it('shows Admins to someone who can read admins', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'admins.read' })
    renderShell()
    expect(screen.getByRole('link', { name: 'Admins' })).toHaveAttribute('href', '/settings/admins')
    expect(screen.queryByRole('link', { name: 'Roles' })).toBeNull()
  })

  it('hides Countries, and its whole Masters group, from an admin without the permission', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => false })
    renderShell()
    expect(screen.queryByRole('link', { name: 'Countries' })).toBeNull()
    expect(screen.queryByText('Masters')).toBeNull()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('marks the current page', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: true, can: () => true })
    renderShell('/masters/locations/countries')
    expect(screen.getByRole('link', { name: 'Countries' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('links the new modules by their permissions', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => ['settings.read', 'banners.read', 'payment_config.read'].includes(key) })
    renderShell()
    expect(screen.getByRole('link', { name: 'Global settings' })).toHaveAttribute('href', '/settings/general')
    expect(screen.getByRole('link', { name: 'Banners' })).toHaveAttribute('href', '/cms/banners')
    expect(screen.getByRole('link', { name: 'Fee configuration' })).toHaveAttribute('href', '/payments/config')
    expect(screen.getByRole('link', { name: 'My account' })).toHaveAttribute('href', '/account')
  })

  it('hides them from an admin without those permissions', () => {
    vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: () => false })
    renderShell()
    for (const name of ['Global settings', 'Banners', 'Fee configuration']) expect(screen.queryByRole('link', { name })).toBeNull()
  })
})
