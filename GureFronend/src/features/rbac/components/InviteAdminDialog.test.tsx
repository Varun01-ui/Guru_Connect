import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { inviteAdmin } from '../api/rbac.api'
import { roleSummaries } from '../testData'
import { InviteAdminDialog } from './InviteAdminDialog'

vi.mock('../api/rbac.api')

const onClose = vi.fn()
const onInvited = vi.fn()
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
const pick = (name: RegExp) => fireEvent.click(screen.getByRole('checkbox', { name }))

function fillValid() {
  type('Email', 'Anjali@GuruConnect.in')
  type('Full name', 'Anjali Menon')
  pick(/Verification Admin/)
}

beforeEach(() => {
  vi.resetAllMocks()
  render(<InviteAdminDialog roles={roleSummaries} onClose={onClose} onInvited={onInvited} />)
})

describe('InviteAdminDialog', () => {
  it('lists every role to choose from', () => {
    expect(screen.getByRole('dialog', { name: 'Invite an admin' })).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByRole('checkbox', { name: /Verification Admin/ })).not.toBeChecked()
  })

  it('shows every problem and makes no request when the form is empty', async () => {
    send()
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Name must be 2–100 characters.')).toBeInTheDocument()
    expect(screen.getByText('Choose 1–5 roles.')).toBeInTheDocument()
    expect(inviteAdmin).not.toHaveBeenCalled()
  })

  it.each([
    ['not an email', 'Email', 'anjali'],
    ['a name with digits', 'Full name', 'Anjali 2'],
  ])('rejects %s', async (_label, field, value) => {
    fillValid()
    type(field, value)
    send()
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(inviteAdmin).not.toHaveBeenCalled()
  })

  it('rejects a reason that is too short but allows none at all', async () => {
    vi.mocked(inviteAdmin).mockResolvedValue({ id: 'a', email: 'a@b.co', status: 'invited', roles: [], inviteExpiresAt: '2026-10-14T10:00:00.000Z' })
    fillValid()
    type('Reason (needed for roles with sensitive permissions)', 'no')
    send()
    expect(await screen.findByText('Add a reason (5–500 characters).')).toBeInTheDocument()
    expect(inviteAdmin).not.toHaveBeenCalled()
    type('Reason (needed for roles with sensitive permissions)', '')
    send()
    await waitFor(() => expect(inviteAdmin).toHaveBeenCalled())
  })

  it('sends the trimmed details and reports the result', async () => {
    vi.mocked(inviteAdmin).mockResolvedValue({ id: 'a', email: 'anjali@guruconnect.in', status: 'invited', roles: [{ code: 'verification_admin' }], inviteExpiresAt: '2026-10-14T10:00:00.000Z' })
    fillValid()
    pick(/City Launch Admin/)
    type('Reason (needed for roles with sensitive permissions)', ' New verification hire ')
    send()
    await waitFor(() => expect(onInvited).toHaveBeenCalledWith({ email: 'anjali@guruconnect.in', inviteExpiresAt: '2026-10-14T10:00:00.000Z' }))
    expect(inviteAdmin).toHaveBeenCalledWith({ email: 'Anjali@GuruConnect.in', fullName: 'Anjali Menon', roleIds: ['r-verif', 'r-city'], reason: 'New verification hire' })
  })

  it('allows at most five roles', async () => {
    cleanup()
    const many = Array.from({ length: 6 }, (_, i) => ({ ...roleSummaries[0]!, id: `r${i}`, name: `Role ${i}` }))
    render(<InviteAdminDialog roles={many} onClose={onClose} onInvited={onInvited} />)
    screen.getAllByRole('checkbox').forEach((b) => fireEvent.click(b))
    type('Email', 'a@b.co')
    type('Full name', 'Anjali Menon')
    send()
    expect(await screen.findByText('Choose 1–5 roles.')).toBeInTheDocument()
    expect(inviteAdmin).not.toHaveBeenCalled()
  })

  it('shows an existing email under the email field', async () => {
    vi.mocked(inviteAdmin).mockRejectedValue(new ApiError(409, 'CONFLICT_DUPLICATE', 'An admin with this email already exists.'))
    fillValid()
    send()
    expect(await screen.findByText('An admin with this email already exists.')).toBeInTheDocument()
    expect(onInvited).not.toHaveBeenCalled()
  })

  it('maps a server validation message (reason needed) to its field', async () => {
    vi.mocked(inviteAdmin).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Add a reason for granting sensitive permissions.', [{ path: 'reason', message: 'Add a reason for granting sensitive permissions.' }]))
    fillValid()
    send()
    expect(await screen.findByText('Add a reason for granting sensitive permissions.')).toBeInTheDocument()
  })

  it('shows a refusal such as "only a Super Admin can grant Super Admin" as a form alert', async () => {
    vi.mocked(inviteAdmin).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Only a Super Admin can grant Super Admin.'))
    fillValid()
    send()
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Super Admin can grant Super Admin.')
  })

  it('closes on Cancel and on Escape', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
