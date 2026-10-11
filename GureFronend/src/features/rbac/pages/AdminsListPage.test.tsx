import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchAdmins, fetchRoles, inviteAdmin } from '../api/rbac.api'
import type { AdminRow } from '../api/rbac.api'
import { anjali, asAdminRow, roleSummaries } from '../testData'
import { AdminsListPage } from './AdminsListPage'

vi.mock('../api/rbac.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canManage: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'admins.read' || (canManage && key === 'admins.manage') })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AdminsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
const page = (data: AdminRow[], over: Partial<{ page: number; pageSize: number; total: number; totalPages: number }> = {}) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: 1, ...over } })
const boss: AdminRow = { ...asAdminRow(anjali), id: 'a-boss', fullName: 'Ravi Shah', email: 'ravi@guruconnect.in', isSuperAdmin: true, roles: [{ id: 'r-super', code: 'super_admin', name: 'Super Admin' }] }
const newcomer: AdminRow = { ...asAdminRow(anjali), id: 'a-new', fullName: 'Nikhil Rao', email: 'nikhil@guruconnect.in', status: 'invited', roles: [], lastLoginAt: null }
const lastParams = () => vi.mocked(fetchAdmins).mock.calls.at(-1)![0]

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(fetchRoles).mockResolvedValue(roleSummaries)
  vi.mocked(fetchAdmins).mockResolvedValue(page([asAdminRow(anjali), boss, newcomer]))
})

describe('AdminsListPage', () => {
  it('shows a loading state', () => {
    vi.mocked(fetchAdmins).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading admins…')).toBeInTheDocument()
  })

  it('lists admins with roles, status and last sign-in', async () => {
    show()
    const row = (await screen.findByRole('link', { name: 'Anjali Menon' })).closest('tr')!
    expect(screen.getByRole('link', { name: 'Anjali Menon' })).toHaveAttribute('href', '/settings/admins/a-anjali')
    expect(within(row).getByText('anjali@guruconnect.in')).toBeInTheDocument()
    expect(within(row).getByText('Verification Admin')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: 'Ravi Shah' }).closest('tr')!).getByText('Super Admin')).toBeInTheDocument()
    const invited = screen.getByRole('link', { name: 'Nikhil Rao' }).closest('tr')!
    expect(within(invited).getByText('Invited')).toBeInTheDocument()
    expect(within(invited).getByText('Never')).toBeInTheDocument()
    expect(within(invited).getByText('No roles')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument()
  })

  it('searches after a pause, but only from 2 characters', async () => {
    show()
    await screen.findByRole('link', { name: 'Anjali Menon' })
    fireEvent.change(screen.getByLabelText('Search admins'), { target: { value: 'a' } })
    await new Promise((r) => setTimeout(r, 450))
    expect(lastParams().q).toBeUndefined()
    fireEvent.change(screen.getByLabelText('Search admins'), { target: { value: 'anj' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'anj', page: 1 }), { timeout: 2000 })
  })

  it('filters by status, role and last sign-in', async () => {
    show()
    await screen.findByRole('link', { name: 'Anjali Menon' })
    await screen.findByRole('option', { name: 'City Launch Admin' })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'disabled' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'disabled' }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-city' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'disabled', roleId: 'r-city' }))
    fireEvent.change(screen.getByLabelText('Last sign-in'), { target: { value: 'stale30' } })
    await waitFor(() => expect(lastParams()).toMatchObject({ lastLogin: 'stale30' }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } })
    await waitFor(() => expect(lastParams().status).toBeUndefined())
  })

  it('says nothing matches when a filter returns no one', async () => {
    show()
    await screen.findByRole('link', { name: 'Anjali Menon' })
    vi.mocked(fetchAdmins).mockResolvedValue(page([]))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'locked' } })
    expect(await screen.findByText('No admins match your filters.')).toBeInTheDocument()
  })

  it('pages through the list', async () => {
    vi.mocked(fetchAdmins).mockImplementation(async (params) => page([asAdminRow(anjali)], { page: params.page, pageSize: params.pageSize, total: 45, totalPages: 3 }))
    show()
    await screen.findByText('Showing 1–20 of 45')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')
    expect(lastParams()).toMatchObject({ page: 2 })
  })

  it('shows the API error and retries', async () => {
    vi.mocked(fetchAdmins).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'The server is unwell.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is unwell.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Anjali Menon' })).toBeInTheDocument()
  })

  it('invites an admin and confirms with the link expiry', async () => {
    vi.mocked(inviteAdmin).mockResolvedValue({ id: 'a-x', email: 'new@guruconnect.in', status: 'invited', roles: [{ code: 'verification_admin' }], inviteExpiresAt: '2026-10-14T10:00:00.000Z' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Invite admin' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite an admin' })
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'new@guruconnect.in' } })
    fireEvent.change(within(dialog).getByLabelText('Full name'), { target: { value: 'Neha Kapoor' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Verification Admin/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Invitation sent to new@guruconnect.in.')
  })

  it('hides "Invite admin" from an admin who can only view', async () => {
    as(false)
    show()
    await screen.findByRole('link', { name: 'Anjali Menon' })
    expect(screen.queryByRole('button', { name: 'Invite admin' })).toBeNull()
  })
})
