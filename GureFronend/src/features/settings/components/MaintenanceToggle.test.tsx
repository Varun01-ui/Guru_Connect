import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MaintenanceToggle } from './MaintenanceToggle'

const setup = (checked = false, disabled = false) => {
  const onChange = vi.fn()
  render(<MaintenanceToggle checked={checked} disabled={disabled} onChange={onChange} />)
  return onChange
}

describe('MaintenanceToggle', () => {
  it('asks for a typed confirmation before switching on', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('switch', { name: 'Maintenance mode' }))
    expect(screen.getByRole('dialog', { name: 'Switch on maintenance mode?' })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: 'Switch on' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type MAINTENANCE to confirm'), { target: { value: 'maintenance' } })
    expect(confirm).toBeDisabled() // case matters
    fireEvent.change(screen.getByLabelText('Type MAINTENANCE to confirm'), { target: { value: 'MAINTENANCE' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does nothing if the dialog is cancelled, and forgets what was typed', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.change(screen.getByLabelText('Type MAINTENANCE to confirm'), { target: { value: 'MAINTENANCE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByLabelText('Type MAINTENANCE to confirm')).toHaveValue('')
  })

  it('switches off straight away, without a dialog', () => {
    const onChange = setup(true)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cannot be used while disabled', () => {
    setup(false, true)
    expect(screen.getByRole('switch')).toBeDisabled()
  })
})
