import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PricePreviewCard } from './PricePreviewCard'

const card = { title: 'Parent membership · Yearly', priceText: '₹1,799 / year', perMonthText: '₹150 / month', gstText: 'incl. ₹274 GST', trialText: '7-day free trial', enabled: true }

describe('PricePreviewCard', () => {
  it('shows exactly what the server built', () => {
    render(<PricePreviewCard card={card} />)
    expect(screen.getByRole('heading', { name: 'Parent membership · Yearly' })).toBeInTheDocument()
    for (const text of ['₹1,799 / year', '₹150 / month', 'incl. ₹274 GST', '7-day free trial']) expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('leaves out lines the server did not send', () => {
    render(<PricePreviewCard card={{ ...card, perMonthText: null, gstText: null, trialText: null }} />)
    expect(screen.queryByRole('list')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('explains a switched-off fee instead of showing a price', () => {
    render(<PricePreviewCard card={{ ...card, enabled: false }} />)
    expect(screen.getByText(/Switched off/)).toBeInTheDocument()
    expect(screen.queryByText('₹1,799 / year')).toBeNull()
  })
})
