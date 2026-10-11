import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchRoles } from '../api/rbac.api'
import { roleSummaries } from '../testData'
import { RolesListPage } from './RolesListPage'

vi.mock('../api/rbac.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canManage: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'roles.read' || (canManage && key === 'roles.manage') })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RolesListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(fetchRoles).mockResolvedValue(roleSummaries)
})

describe('RolesListPage', () => {
  it('shows a loading state, then a card per role with counts and a System badge', async () => {
    vi.mocked(fetchRoles).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading roles…')).toBeInTheDocument()
  })

  it('lists roles with their permission and admin counts', async () => {
    show()
    const card = (await screen.findByRole('link', { name: /Verification Admin/ })) as HTMLAnchorElement
    expect(card).toHaveAttribute('href', '/settings/roles/r-verif')
    expect(card).toHaveTextContent('System')
    expect(card).toHaveTextContent('Reviews teacher documents')
    expect(card).toHaveTextContent('Permissions2')
    expect(card).toHaveTextContent('Admins2')
    expect(screen.getByRole('link', { name: /City Launch Admin/ })).not.toHaveTextContent('System')
  })

  it('filters by name or description as you type', async () => {
    show()
    await screen.findByRole('link', { name: /Super Admin/ })
    fireEvent.change(screen.getByLabelText('Filter roles'), { target: { value: 'new city' } })
    expect(screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/settings/roles/r-'))).toHaveLength(1)
    expect(screen.getByRole('link', { name: /City Launch Admin/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter roles'), { target: { value: 'zzz' } })
    expect(screen.getByText('No roles match your filter.')).toBeInTheDocument()
  })

  it('offers "New role" only to someone who can manage roles', async () => {
    show()
    expect(await screen.findByRole('link', { name: 'New role' })).toHaveAttribute('href', '/settings/roles/new')
  })

  it('hides "New role" from a read-only admin', async () => {
    as(false)
    show()
    await screen.findByRole('link', { name: /Super Admin/ })
    expect(screen.queryByRole('link', { name: 'New role' })).toBeNull()
  })

  it('shows the API error and retries', async () => {
    vi.mocked(fetchRoles).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'The server is unwell.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is unwell.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: /Super Admin/ })).toBeInTheDocument()
  })
})
