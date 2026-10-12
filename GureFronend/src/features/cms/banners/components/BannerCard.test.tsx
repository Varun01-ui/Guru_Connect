import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { banner } from '../testData'
import { BannerCard } from './BannerCard'

const show = (b = banner(), props: Partial<Parameters<typeof BannerCard>[0]> = {}) => {
  const onAction = vi.fn()
  const onMove = vi.fn()
  render(
    <MemoryRouter>
      <ul>
        <BannerCard banner={b} canManage busy={false} onAction={onAction} onMove={onMove} {...props} />
      </ul>
    </MemoryRouter>,
  )
  return { onAction, onMove }
}

describe('BannerCard', () => {
  it('shows the title, status, placement, audience, cities, dates and click-through', () => {
    show()
    expect(screen.getByRole('link', { name: 'Board exams in 90 days' })).toHaveAttribute('href', '/cms/banners/b1')
    expect(screen.getByText('draft')).toBeInTheDocument()
    expect(screen.getByText('Home · top')).toBeInTheDocument()
    expect(screen.getByText(/Parents · Bengaluru/)).toBeInTheDocument()
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    expect(screen.getByText(/200/)).toBeInTheDocument()
  })

  it('says "all cities" and "until paused" and a dash for CTR when there is nothing yet', () => {
    show(banner({ cities: [], endsAt: null, ctrPct: null, impressions: 0, clicks: 0 }))
    expect(screen.getByText(/all cities/)).toBeInTheDocument()
    expect(screen.getByText(/until paused/)).toBeInTheDocument()
    expect(screen.getByText('—', { exact: false })).toBeInTheDocument()
  })

  it.each([
    ['draft', ['Publish', 'Delete']],
    ['scheduled', ['Delete']],
    ['active', ['Pause']],
    ['paused', ['Resume', 'Delete']],
    ['expired', ['Delete']],
  ] as const)('offers the right actions for a %s banner', (status, actions) => {
    show(banner({ status }))
    for (const name of ['Publish', 'Pause', 'Resume', 'Delete']) {
      const present = screen.queryByRole('button', { name })
      if ((actions as readonly string[]).includes(name)) expect(present, name).toBeInTheDocument()
      else expect(present, name).toBeNull()
    }
  })

  it('reports the chosen action', () => {
    const { onAction } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(onAction).toHaveBeenCalledWith('publish')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onAction).toHaveBeenCalledWith('delete')
  })

  it('shows no actions to someone who cannot manage banners, only View', () => {
    show(banner(), { canManage: false })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('link', { name: 'View' })).toBeInTheDocument()
  })

  it('moves up and down, with the ends disabled', () => {
    const { onMove } = show(banner(), { isFirst: true, isLast: false })
    expect(screen.getByRole('button', { name: 'Move Board exams in 90 days up' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move Board exams in 90 days down' }))
    expect(onMove).toHaveBeenCalledWith(1)
  })

  it('hides the move buttons when the list is not one ordered placement', () => {
    show(banner(), { onMove: undefined })
    expect(screen.queryByRole('group')).toBeNull()
  })
})
