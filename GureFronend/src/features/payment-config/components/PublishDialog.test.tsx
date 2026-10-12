import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PublishDialog } from './PublishDialog'

const impact = { liveSubscriptionsOnCurrentVersion: 1824, openCheckouts: 3, changePercent: -10 }
const show = (over: Partial<Parameters<typeof PublishDialog>[0]> = {}) => {
  const onPublish = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<PublishDialog feeName="Parent membership · Yearly" currentPaise={199900} draftPaise={179900} impact={impact} onPublish={onPublish} onClose={onClose} {...over} />)
  return { onPublish, onClose }
}
const reason = (text = 'Diwali offer from 1 Nov') => fireEvent.change(screen.getByLabelText('Reason'), { target: { value: text } })

describe('PublishDialog', () => {
  it('summarises the impact: price change, live subscriptions and open checkouts', () => {
    show()
    const list = screen.getByRole('list', { name: 'Impact' })
    expect(list).toHaveTextContent('Price change: -10%')
    expect(list).toHaveTextContent('1,824 live subscriptions keep their current price')
    expect(list).toHaveTextContent('3 checkouts are open right now')
  })

  it('has no price-change line for a first price, and copes with no impact yet', () => {
    show({ currentPaise: null, impact: null })
    expect(screen.getByRole('list', { name: 'Impact' })).toBeEmptyDOMElement()
  })

  it('publishes now with the reason', async () => {
    const { onPublish } = show()
    reason()
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }))
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({ reason: 'Diwali offer from 1 Nov', confirmLargeChange: false }))
  })

  it('schedules for a time read as Indian time', async () => {
    const { onPublish } = show()
    fireEvent.click(screen.getByRole('radio', { name: 'Schedule' }))
    fireEvent.change(screen.getByLabelText('Starts (IST)'), { target: { value: '2026-11-01T00:00' } })
    reason()
    fireEvent.click(screen.getByRole('button', { name: 'Schedule change' }))
    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({ effectiveFrom: '2026-10-31T18:30:00.000Z', reason: 'Diwali offer from 1 Nov', confirmLargeChange: false }))
  })

  it('will not schedule without a time', async () => {
    const { onPublish } = show()
    fireEvent.click(screen.getByRole('radio', { name: 'Schedule' }))
    reason()
    fireEvent.click(screen.getByRole('button', { name: 'Schedule change' }))
    expect(await screen.findByText('Pick when the change should start.')).toBeInTheDocument()
    expect(onPublish).not.toHaveBeenCalled()
  })
})
