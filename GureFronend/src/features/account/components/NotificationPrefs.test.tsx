import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { profile } from '../testData'
import { NotificationPrefs } from './NotificationPrefs'

const onSave = vi.fn()
const onConflict = vi.fn()
const show = (busy = false) => render(<NotificationPrefs profile={profile} busy={busy} onSave={onSave} onConflict={onConflict} />)

beforeEach(() => {
  vi.resetAllMocks()
  onSave.mockResolvedValue(undefined)
})

describe('NotificationPrefs', () => {
  it('shows each alert’s current state', () => {
    show()
    expect(screen.getByRole('switch', { name: 'Daily email digest' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Queue alerts' })).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps security alerts on and locked', () => {
    show()
    const security = screen.getByRole('switch', { name: 'Security alerts' })
    expect(security).toHaveAttribute('aria-checked', 'true')
    expect(security).toBeDisabled()
  })

  it('saves a flipped alert straight away, sending only that one', async () => {
    show()
    fireEvent.click(screen.getByRole('switch', { name: 'Queue alerts' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ notificationPrefs: { queue_alerts: true } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Daily email digest' }))
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ notificationPrefs: { email_digest: false } }))
  })

  it('shows a failure and reports a conflict', async () => {
    onSave.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Your profile changed in another tab. Reload.'))
    show()
    fireEvent.click(screen.getByRole('switch', { name: 'Queue alerts' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your profile changed in another tab. Reload.')
    expect(onConflict).toHaveBeenCalled()
  })

  it('locks the switches while a save is running', () => {
    show(true)
    expect(screen.getByRole('switch', { name: 'Queue alerts' })).toBeDisabled()
  })
})
