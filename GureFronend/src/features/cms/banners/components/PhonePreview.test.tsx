import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhonePreview } from './PhonePreview'

describe('PhonePreview', () => {
  it('shows each banner’s headline, subtitle and caption', () => {
    render(<PhonePreview items={[{ id: '1', title: 'Board exams', subtitle: 'Book a demo', imageUrl: 'https://cdn.test/a.png' }]} caption="Live preview" />)
    expect(screen.getByText('Board exams')).toBeInTheDocument()
    expect(screen.getByText('Book a demo')).toBeInTheDocument()
    expect(screen.getByText('Live preview')).toBeInTheDocument()
    expect(screen.getAllByTestId('preview-banner')).toHaveLength(1)
  })

  it('shows a placeholder headline while the title is empty', () => {
    render(<PhonePreview items={[{ title: '' }]} />)
    expect(screen.getByText('Your headline')).toBeInTheDocument()
  })

  it('says so when there is nothing to show', () => {
    render(<PhonePreview items={[]} emptyText="No live banner here." />)
    expect(screen.getByText('No live banner here.')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-banner')).toBeNull()
  })
})
