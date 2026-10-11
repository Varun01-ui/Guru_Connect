import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { createRole, deleteRole, fetchPermissionCatalogue, fetchRole, fetchRoles, patchRole, putRolePermissions } from '../api/rbac.api'
import { catalogue, cityRole, roleSummaries, superRole, verificationRole } from '../testData'
import { RoleEditorPage } from './RoleEditorPage'

vi.mock('../api/rbac.api')
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canManage: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => key === 'roles.read' || (canManage && key === 'roles.manage') })

function open(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/roles" element={<div>Roles list page</div>} />
          <Route path="/settings/roles/new" element={<RoleEditorPage />} />
          <Route path="/settings/roles/:id" element={<RoleEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const box = (key: string) => screen.getByRole('checkbox', { name: key })

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(fetchPermissionCatalogue).mockResolvedValue(catalogue)
  vi.mocked(fetchRoles).mockResolvedValue(roleSummaries)
  vi.mocked(fetchRole).mockImplementation(async (id) => ({ 'r-verif': verificationRole, 'r-city': cityRole, 'r-super': superRole })[id]!)
})

describe('RoleEditorPage — editing a role', () => {
  it('shows the role, its permissions ticked, and who holds it', async () => {
    open('/settings/roles/r-verif')
    expect(await screen.findByRole('heading', { name: /Verification Admin/ })).toHaveTextContent('System')
    await screen.findByRole('region', { name: 'Teachers' })
    expect(box('teachers.read')).toBeChecked()
    expect(box('teachers.update')).not.toBeChecked()
    expect(screen.getByLabelText('Role name')).toBeDisabled() // system roles can't be renamed
    expect(screen.getByRole('link', { name: 'Anjali Menon' })).toHaveAttribute('href', '/settings/admins/a-anjali')
    expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull()
  })

  it('saves a changed set of permissions with the version it was read at', async () => {
    vi.mocked(putRolePermissions).mockResolvedValue({ ...verificationRole, permissionKeys: ['teachers.read', 'locations.read', 'teachers.update'], updatedAt: '2026-10-02T00:00:00.000Z' })
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull()

    fireEvent.click(box('teachers.update'))
    expect(screen.getByText(/Adding 1 permission/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Permissions saved.')
    expect(putRolePermissions).toHaveBeenCalledWith('r-verif', ['teachers.read', 'locations.read', 'teachers.update'], '2026-09-20T08:11:02.114Z', undefined)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save permissions' })).toBeNull())
  })

  it('counts removals too, and Discard puts the matrix back', async () => {
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.click(box('teachers.read'))
    fireEvent.click(box('teachers.update'))
    expect(screen.getByText(/Adding 1, removing 1 permissions/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' }).at(-1)!)
    expect(box('teachers.read')).toBeChecked()
    expect(box('teachers.update')).not.toBeChecked()
  })

  it('asks for a reason before granting a sensitive permission', async () => {
    vi.mocked(putRolePermissions).mockResolvedValue(verificationRole)
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.click(box('teachers.export'))
    expect(screen.getByLabelText('Reason for granting sensitive permissions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    expect(await screen.findByText('Add a reason (5–500 characters).')).toBeInTheDocument()
    expect(putRolePermissions).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Reason for granting sensitive permissions'), { target: { value: 'Needs the monthly report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    await waitFor(() => expect(putRolePermissions).toHaveBeenCalled())
    expect(vi.mocked(putRolePermissions).mock.calls[0]![3]).toBe('Needs the monthly report')
  })

  it('does not ask for a reason when a sensitive permission is only being removed', async () => {
    vi.mocked(fetchRole).mockResolvedValue({ ...verificationRole, permissionKeys: ['teachers.read', 'teachers.export'] })
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.click(box('teachers.export'))
    expect(screen.queryByLabelText('Reason for granting sensitive permissions')).toBeNull()
  })

  it('explains a stale matrix and reloads the latest role', async () => {
    vi.mocked(putRolePermissions).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Someone else changed this role. Reload to see their changes.'))
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.click(box('teachers.update'))
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    const banner = await screen.findByText('Someone else changed this role. Reload to see their changes.')
    expect(banner).toBeInTheDocument()
    vi.mocked(fetchRole).mockResolvedValue({ ...verificationRole, permissionKeys: ['teachers.read', 'teachers.update', 'locations.read'] })
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(box('teachers.update')).toBeChecked())
    expect(screen.queryByText('Someone else changed this role. Reload to see their changes.')).toBeNull()
  })

  it('shows Super Admin as holding everything and not editable', async () => {
    open('/settings/roles/r-super')
    expect(await screen.findByText('Super Admin always has every permission.')).toBeInTheDocument()
    await screen.findByRole('region', { name: 'Teachers' })
    for (const b of screen.getAllByRole('checkbox')) expect(b).toBeDisabled()
    expect(box('teachers.export')).toBeChecked()
  })

  it('is read-only for an admin who can only view roles', async () => {
    as(false)
    open('/settings/roles/r-city')
    await screen.findByRole('region', { name: 'Locations' })
    expect(screen.getByText('You can view this role but not change it.')).toBeInTheDocument()
    expect(screen.getByLabelText('Role name')).toBeDisabled()
    expect(screen.getByLabelText('Description')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull()
    for (const b of screen.getAllByRole('checkbox')) expect(b).toBeDisabled()
  })

  it('renames a custom role and saves its description', async () => {
    vi.mocked(patchRole).mockResolvedValue({ ...cityRole, name: 'City Opening Admin' })
    open('/settings/roles/r-city')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'City Opening Admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Role details saved.')
    expect(patchRole).toHaveBeenCalledWith('r-city', { name: 'City Opening Admin' }, '2026-09-20T08:11:02.114Z')
    expect(await screen.findByRole('heading', { name: /City Opening Admin/ })).toBeInTheDocument()
  })

  it('validates the name and shows a duplicate-name error under it', async () => {
    vi.mocked(patchRole).mockRejectedValue(new ApiError(409, 'CONFLICT_DUPLICATE', 'A role with this name already exists.'))
    open('/settings/roles/r-city')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'ab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(await screen.findByText('Role name must be 3–50 characters.')).toBeInTheDocument()
    expect(patchRole).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Verification Admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(await screen.findByText('A role with this name already exists.')).toBeInTheDocument()
  })

  it('lets a system role change only its description', async () => {
    vi.mocked(patchRole).mockResolvedValue({ ...verificationRole, description: 'New text' })
    open('/settings/roles/r-verif')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    await waitFor(() => expect(patchRole).toHaveBeenCalledWith('r-verif', { description: 'New text' }, '2026-09-20T08:11:02.114Z'))
  })

  it('deletes a custom role after confirmation and returns to the list', async () => {
    vi.mocked(deleteRole).mockResolvedValue(undefined)
    open('/settings/roles/r-city')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete City Launch Admin?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }))
    expect(await screen.findByText('Roles list page')).toBeInTheDocument()
    expect(deleteRole).toHaveBeenCalledWith('r-city')
  })

  it('says why a role that admins still hold cannot be deleted', async () => {
    vi.mocked(deleteRole).mockRejectedValue(new ApiError(409, 'CONFLICT_IN_USE', 'Remove this role from 2 admins first.'))
    open('/settings/roles/r-city')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete role' }))
    expect(await within(screen.getByRole('alertdialog')).findByText('Remove this role from 2 admins first.')).toBeInTheDocument()
    expect(screen.queryByText('Roles list page')).toBeNull()
  })

  it('explains a role that no longer exists', async () => {
    vi.mocked(fetchRole).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'This role no longer exists.'))
    open('/settings/roles/gone')
    expect(await screen.findByRole('alert')).toHaveTextContent('This role no longer exists.')
    expect(screen.getByRole('link', { name: 'Back to roles' })).toBeInTheDocument()
  })
})

describe('RoleEditorPage — creating a role', () => {
  it('starts empty', async () => {
    open('/settings/roles/new')
    expect(screen.getByRole('heading', { name: 'New role' })).toBeInTheDocument()
    await screen.findByRole('region', { name: 'Teachers' })
    expect(screen.getByText('Permissions (0 selected)')).toBeInTheDocument()
  })

  it('creates a role with the ticked permissions and opens it', async () => {
    vi.mocked(createRole).mockResolvedValue({ ...cityRole, id: 'r-new' })
    open('/settings/roles/new')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: '  City Launch Admin ' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Sets up a new city' } })
    fireEvent.click(box('locations.read'))
    fireEvent.click(box('locations.manage'))
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }))

    await waitFor(() => expect(createRole).toHaveBeenCalled())
    expect(createRole).toHaveBeenCalledWith({ name: 'City Launch Admin', description: 'Sets up a new city', permissionKeys: ['locations.read', 'locations.manage'] })
    await waitFor(() => expect(fetchRole).toHaveBeenCalledWith('r-new'))
  })

  it('copies the permissions of an existing role into the matrix', async () => {
    open('/settings/roles/new')
    await screen.findByRole('region', { name: 'Locations' })
    fireEvent.change(screen.getByLabelText('Start from an existing role'), { target: { value: 'r-verif' } })
    await waitFor(() => expect(box('teachers.read')).toBeChecked())
    expect(box('locations.read')).toBeChecked()
    expect(box('teachers.update')).not.toBeChecked()
    expect(screen.getByText('Permissions (2 selected)')).toBeInTheDocument()
  })

  it('validates the name and needs a reason for sensitive permissions', async () => {
    open('/settings/roles/new')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }))
    expect(await screen.findByText('Role name must be 3–50 characters.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Report Reader' } })
    fireEvent.click(box('teachers.export'))
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }))
    expect(await screen.findByText('Add a reason (5–500 characters).')).toBeInTheDocument()
    expect(createRole).not.toHaveBeenCalled()
  })

  it('shows a duplicate name under the field', async () => {
    vi.mocked(createRole).mockRejectedValue(new ApiError(409, 'CONFLICT_DUPLICATE', 'A role with this name already exists.'))
    open('/settings/roles/new')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Finance Admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }))
    expect(await screen.findByText('A role with this name already exists.')).toBeInTheDocument()
  })

  it('shows an unexpected failure as a form-level alert', async () => {
    vi.mocked(createRole).mockRejectedValue(new Error('network down'))
    open('/settings/roles/new')
    await screen.findByRole('region', { name: 'Teachers' })
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Report Reader' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the role. Try again.')
  })
})
