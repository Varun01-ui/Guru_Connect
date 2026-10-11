import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { fetchRole, putAdminRoles } from '../api/rbac.api'
import { anjali, cityRole, roleSummaries, superRole, verificationRole } from '../testData'
import { AssignRolesDialog } from './AssignRolesDialog'

vi.mock('../api/rbac.api')

const onClose = vi.fn()
const onSaved = vi.fn()
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AssignRolesDialog admin={anjali} roles={roleSummaries} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  )
const pick = (name: RegExp) => fireEvent.click(screen.getByRole('checkbox', { name }))
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save roles' }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchRole).mockImplementation(async (id) => ({ 'r-verif': verificationRole, 'r-city': cityRole, 'r-super': superRole })[id]!)
})

describe('AssignRolesDialog', () => {
  it('starts on the admin’s current roles with nothing to save', async () => {
    show()
    expect(screen.getByRole('dialog', { name: 'Roles for Anjali Menon' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Verification Admin/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /City Launch Admin/ })).not.toBeChecked()
    expect(screen.getByText('No change yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save roles' })).toBeDisabled()
  })

  it('shows what they would gain before saving', async () => {
    show()
    pick(/City Launch Admin/)
    expect(await screen.findByText('Gains (1)')).toBeInTheDocument()
    expect(screen.getByText('locations.manage')).toBeInTheDocument()
    expect(screen.queryByText(/^Loses/)).toBeNull()
  })

  it('shows what they would lose when a role is removed', async () => {
    show()
    pick(/Verification Admin/)
    pick(/City Launch Admin/)
    expect(await screen.findByText('Gains (1)')).toBeInTheDocument()
    expect(screen.getByText('Loses (1)')).toBeInTheDocument()
    expect(screen.getByText('teachers.read')).toBeInTheDocument()
  })

  it('says so when the permissions do not change', async () => {
    show()
    pick(/City Launch Admin/)
    await screen.findByText('Gains (1)')
    pick(/City Launch Admin/)
    pick(/Super Admin/)
    pick(/Super Admin/)
    expect(await screen.findByText('No change yet.')).toBeInTheDocument()
  })

  it('saves the new set of roles with the reason', async () => {
    vi.mocked(putAdminRoles).mockResolvedValue({ ...anjali, roles: [...anjali.roles, { id: 'r-city', code: 'city_launch_admin', name: 'City Launch Admin' }] })
    show()
    pick(/City Launch Admin/)
    await screen.findByText('Gains (1)')
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: ' Covers the Kochi launch ' } })
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(putAdminRoles).toHaveBeenCalledWith('a-anjali', ['r-verif', 'r-city'], 'Covers the Kochi launch')
  })

  it('needs at least one role and at most five', async () => {
    show()
    pick(/Verification Admin/)
    pick(/City Launch Admin/)
    pick(/City Launch Admin/)
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose 1–5 roles.')
    expect(putAdminRoles).not.toHaveBeenCalled()
  })

  it('shows a too-short reason under the field', async () => {
    show()
    pick(/City Launch Admin/)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'no' } })
    save()
    expect(await screen.findByText('Add a reason (5–500 characters).')).toBeInTheDocument()
    expect(putAdminRoles).not.toHaveBeenCalled()
  })

  it('puts the server’s "reason needed" message under the reason field', async () => {
    vi.mocked(putAdminRoles).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Add a reason for granting sensitive permissions.', [{ path: 'reason', message: 'Add a reason for granting sensitive permissions.' }]))
    show()
    pick(/Super Admin/)
    save()
    expect(await screen.findByText('Add a reason for granting sensitive permissions.')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows other refusals as an alert and stays open', async () => {
    vi.mocked(putAdminRoles).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can grant Super Admin.'))
    show()
    pick(/Super Admin/)
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Super Admin can grant Super Admin.')
    expect(screen.getByRole('button', { name: 'Save roles' })).toBeEnabled()
  })

  it('closes on Cancel and on Escape', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
