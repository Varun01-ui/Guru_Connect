import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeepLinkPicker } from './DeepLinkPicker'

const show = (value: string | null = null, error?: string) => {
  const onChange = vi.fn()
  render(<DeepLinkPicker value={value} error={error} onChange={onChange} />)
  return onChange
}
const pickKind = (label: string) => fireEvent.change(screen.getByLabelText('When tapped, open'), { target: { value: label } })

describe('DeepLinkPicker', () => {
  it('starts on "No link" with no detail field', () => {
    show()
    expect(screen.getByLabelText('When tapped, open')).toHaveValue('none')
    expect(screen.queryByLabelText('Website link')).toBeNull()
  })

  it('opens on the kind of an existing link, with its detail filled in', () => {
    show('gc://blog/exam-tips')
    expect(screen.getByLabelText('When tapped, open')).toHaveValue('blog')
    expect(screen.getByLabelText('Article slug')).toHaveValue('exam-tips')
  })

  it('reports a link with no detail at once, and clears it for "No link"', () => {
    const onChange = show('gc://referral')
    pickKind('plans')
    expect(onChange).toHaveBeenLastCalledWith('gc://plans')
    pickKind('none')
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('builds the link as the detail is typed', () => {
    const onChange = show()
    pickKind('web')
    fireEvent.change(screen.getByLabelText('Website link'), { target: { value: 'https://guruconnect.in/offers' } })
    expect(onChange).toHaveBeenLastCalledWith('https://guruconnect.in/offers')
  })

  it('shows what is wrong and reports no link while the detail is invalid', () => {
    const onChange = show()
    pickKind('web')
    fireEvent.change(screen.getByLabelText('Website link'), { target: { value: 'http://guruconnect.in' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Use an https:// link.')
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('shows the server’s verdict, for example an unapproved domain', () => {
    show('https://evil.example.com', 'Use an app link or an approved website.')
    expect(screen.getByRole('alert')).toHaveTextContent('Use an app link or an approved website.')
  })
})
