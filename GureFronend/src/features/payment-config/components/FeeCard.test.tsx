import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { summary, version } from '../testData'
import { FeeCard } from './FeeCard'

const show = (fee = summary(), props: Partial<Parameters<typeof FeeCard>[0]> = {}) => {
  const onToggle = vi.fn()
  render(
    <MemoryRouter>
      <ul>
        <FeeCard fee={fee} canPublish busy={false} onToggle={onToggle} {...props} />
      </ul>
    </MemoryRouter>,
  )
  return onToggle
}

describe('FeeCard', () => {
  it('shows the name, code, live price with its period and last-30-day sales', () => {
    show()
    expect(screen.getByRole('link', { name: 'Parent membership · Yearly' })).toHaveAttribute('href', '/payments/config/PARENT_SUBSCRIPTION_YEARLY')
    expect(screen.getByText('PARENT_SUBSCRIPTION_YEARLY')).toBeInTheDocument()
    expect(screen.getByText('₹1,999')).toBeInTheDocument()
    expect(screen.getByText('/ year')).toBeInTheDocument()
    expect(screen.getByText(/412 sales · ₹8,23,588 in 30 days/)).toBeInTheDocument()
  })

  it('has a switch that reports the wanted state', () => {
    const onToggle = show()
    const toggle = screen.getByRole('switch', { name: 'Parent membership · Yearly on or off' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ feeCode: 'PARENT_SUBSCRIPTION_YEARLY' }), false)
  })

  it('locks the switch for someone who cannot publish', () => {
    show(summary(), { canPublish: false })
    expect(screen.getByRole('switch')).toBeDisabled()
  })

  it('flags a switched-off fee', () => {
    show(summary({ active: version({ isEnabled: false }) }))
    expect(screen.getByText('Switched off')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the scheduled change and a draft badge', () => {
    show(summary({ scheduled: version({ id: 'v4', version: 4, status: 'scheduled', amountPaise: 179900, effectiveFrom: '2026-10-31T18:30:00.000Z' }), draft: version({ id: 'd', status: 'draft' }) }))
    expect(screen.getByText(/Changes on 1 Nov, 12:00 am → ₹1,799/)).toBeInTheDocument()
    expect(screen.getByText('Draft in progress')).toBeInTheDocument()
  })

  it('copes with a fee that has no live version', () => {
    show(summary({ active: null }))
    expect(screen.getByText('No live version.')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByRole('link', { name: 'Parent membership · Yearly' })).toBeInTheDocument()
  })
})
