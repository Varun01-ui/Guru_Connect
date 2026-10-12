import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { profile } from '../testData'
import { PreferencesForm } from './PreferencesForm'

const onSave = vi.fn()
const onConflict = vi.fn()
const show = (over = {}) => render(<PreferencesForm profile={{ ...profile, ...over }} busy={false} onSave={onSave} onConflict={onConflict} />)

beforeEach(() => {
  vi.resetAllMocks()
  onSave.mockResolvedValue(undefined)
})
afterEach(() => document.documentElement.removeAttribute('data-theme'))

describe('PreferencesForm', () => {
  it('shows the current theme, time zone and language', () => {
    show({ theme: 'dark', locale: 'hi-IN' })
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(screen.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata')
    expect(screen.getByLabelText('Language')).toHaveValue('hi-IN')
  })

  it('applies a new theme at once and saves it', async () => {
    show()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ theme: 'dark' }))
  })

  it('puts the theme back if saving it fails', async () => {
    onSave.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    show({ theme: 'light' })
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('saves the time zone and language together, only when changed', async () => {
    show()
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Dubai' } })
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi-IN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ timezone: 'Asia/Dubai', locale: 'hi-IN' }))
  })

  it('sends just the time zone when only that changed', async () => {
    show()
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Dubai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ timezone: 'Asia/Dubai' }))
  })

  it('shows the server’s message and flags a conflict', async () => {
    onSave.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Your profile changed in another tab. Reload.'))
    show()
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Dubai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your profile changed in another tab. Reload.')
    expect(onConflict).toHaveBeenCalled()
  })

  it('keeps a saved time zone that the browser’s list does not include', () => {
    show({ timezone: 'Mars/Olympus' })
    expect(screen.getByLabelText('Time zone')).toHaveValue('Mars/Olympus')
  })
})
