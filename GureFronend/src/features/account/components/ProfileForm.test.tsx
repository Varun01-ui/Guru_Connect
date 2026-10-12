import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { profile } from '../testData'
import { ProfileForm } from './ProfileForm'

const onSave = vi.fn()
const onConflict = vi.fn()
const show = (busy = false) => render(<ProfileForm profile={profile} busy={busy} onSave={onSave} onConflict={onConflict} />)
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

beforeEach(() => {
  vi.resetAllMocks()
  onSave.mockResolvedValue(undefined)
})

describe('ProfileForm', () => {
  it('shows the saved details, with the email locked', () => {
    show()
    expect(screen.getByLabelText('Full name')).toHaveValue('Anjali Menon')
    expect(screen.getByLabelText(/Display name/)).toHaveValue('Anjali')
    expect(screen.getByLabelText('Designation')).toHaveValue('Verification Lead')
    expect(screen.getByLabelText('Phone')).toHaveValue('+919845011122')
    expect(screen.getByLabelText('Email')).toBeDisabled()
    expect(screen.getByText('Your email is your sign-in. Ask a Super Admin to change it.')).toBeInTheDocument()
  })

  it('cannot be saved until something changes', () => {
    show()
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled()
    type('Designation', 'Head of Verification')
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled()
  })

  it('sends only what changed, tidied up', async () => {
    show()
    type('Full name', '  Anjali   Menon-Nair ')
    type('Designation', 'Head of Verification')
    submit()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ fullName: 'Anjali Menon-Nair', designation: 'Head of Verification' }))
  })

  it('clears an optional field by sending null', async () => {
    show()
    type('Display name (optional)', '')
    type('Phone', '')
    submit()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ displayName: null, phone: null }))
  })

  it('confirms the save', async () => {
    const { rerender } = render(<ProfileForm profile={profile} busy={false} onSave={onSave} onConflict={onConflict} />)
    type('Designation', 'Head of Verification')
    fireEvent.click(screen.getAllByRole('button', { name: 'Save profile' })[0]!)
    // The page hands the saved profile back down.
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    rerender(<ProfileForm profile={{ ...profile, designation: 'Head of Verification' }} busy={false} onSave={onSave} onConflict={onConflict} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  })

  it.each([
    ['Full name', 'A', 'Name must be 2–100 characters.'],
    ['Display name (optional)', 'A', 'Display name must be 2–40 characters.'],
    ['Designation', 'D'.repeat(81), 'Designation can be up to 80 characters.'],
    ['Phone', '98450 11122', 'Enter a phone number like +919876543210.'],
  ])('rejects %s “%s” before sending anything', async (label, value, message) => {
    show()
    type(label, value)
    submit()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows the server’s field errors', async () => {
    onSave.mockRejectedValue(new ApiError(409, 'CONFLICT_DUPLICATE', 'Another admin already uses this phone number.'))
    show()
    type('Phone', '+919000000000')
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Another admin already uses this phone number.')
  })

  it('maps validation details onto their fields', async () => {
    onSave.mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Enter a phone number like +919876543210.', [{ path: 'phone', message: 'Enter a phone number like +919876543210.' }]))
    show()
    type('Phone', '+919000000000')
    submit()
    expect(await screen.findByText('Enter a phone number like +919876543210.')).toBeInTheDocument()
  })

  it('tells the page when the profile changed elsewhere', async () => {
    onSave.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Your profile changed in another tab. Reload.'))
    show()
    type('Designation', 'Head of Verification')
    submit()
    await waitFor(() => expect(onConflict).toHaveBeenCalled())
    expect(await screen.findByRole('alert')).toHaveTextContent('Your profile changed in another tab. Reload.')
  })

  it('discards edits', () => {
    show()
    type('Designation', 'Something else')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Designation')).toHaveValue('Verification Lead')
  })

  it('disables saving while another save is running', () => {
    show(true)
    type('Designation', 'Head of Verification')
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  })
})
