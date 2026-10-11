import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { deleteAdmin, disableAdmin } from '../api/rbac.api'
import { anjali } from '../testData'
import { DisableAdminDialog } from './DisableAdminDialog'

vi.mock('../api/rbac.api')

const onClose = vi.fn()
const onDone = vi.fn()
const show = (mode: 'disable' | 'delete') => render(<DisableAdminDialog mode={mode} admin={anjali} onClose={onClose} onDone={onDone} />)
const reason = (value: string) => fireEvent.change(screen.getByLabelText('Reason'), { target: { value } })

beforeEach(() => vi.resetAllMocks())

describe('DisableAdminDialog — disable', () => {
  it('explains what disabling does and needs a reason first', async () => {
    show('disable')
    expect(screen.getByRole('dialog', { name: 'Disable Anjali Menon?' })).toHaveTextContent('signed out of every device')
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a reason (5–500 characters).')
    expect(disableAdmin).not.toHaveBeenCalled()
  })

  it('disables the admin with the written reason', async () => {
    const updated = { ...anjali, status: 'disabled' as const }
    vi.mocked(disableAdmin).mockResolvedValue(updated)
    show('disable')
    reason('  Left the company on 30 Sep ')
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('disable', updated))
    expect(disableAdmin).toHaveBeenCalledWith('a-anjali', 'Left the company on 30 Sep')
  })

  it('shows the API refusal (for example the last Super Admin) and stays open', async () => {
    vi.mocked(disableAdmin).mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', "You can't remove the last active Super Admin."))
    show('disable')
    reason('Not needed any more')
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("You can't remove the last active Super Admin.")
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled()
  })
})

describe('DisableAdminDialog — delete', () => {
  it('deletes with the reason and reports no admin left to show', async () => {
    vi.mocked(deleteAdmin).mockResolvedValue(undefined)
    show('delete')
    expect(screen.getByRole('dialog', { name: 'Delete Anjali Menon?' })).toHaveTextContent('audit log')
    reason('Duplicate account')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('delete', null))
    expect(deleteAdmin).toHaveBeenCalledWith('a-anjali', 'Duplicate account')
  })

  it('shows a failure without closing', async () => {
    vi.mocked(deleteAdmin).mockRejectedValue(new Error('network down'))
    show('delete')
    reason('Duplicate account')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this admin. Try again.')
  })

  it('closes on Cancel and on Escape', () => {
    show('delete')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
