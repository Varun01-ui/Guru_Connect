import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { domains, maintenance, maxChildren, redirects, supportEmail, termsUrl } from '../testData'
import { SettingInput } from './SettingInput'

const setup = (setting = supportEmail, value: unknown = setting.value, extra: Partial<Parameters<typeof SettingInput>[0]> = {}) => {
  const onChange = vi.fn()
  const onInvalid = vi.fn()
  render(<SettingInput setting={setting} value={value} onChange={onChange} onInvalid={onInvalid} {...extra} />)
  return { onChange, onInvalid }
}

describe('SettingInput', () => {
  it('shows a text control with its label and help text, and reports typing', () => {
    const { onChange } = setup()
    const input = screen.getByLabelText('Support email')
    expect(input).toHaveValue('support@guruconnect.in')
    expect(input).toHaveAccessibleDescription('Where users send support requests')
    fireEvent.change(input, { target: { value: 'new@guruconnect.in' } })
    expect(onChange).toHaveBeenCalledWith('new@guruconnect.in')
  })

  it('shows a number control with the allowed range, and passes numbers (null when emptied)', () => {
    const { onChange } = setup(maxChildren)
    const input = screen.getByLabelText('Max children per parent')
    expect(input).toHaveAttribute('type', 'number')
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '5')
    fireEvent.change(input, { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith(4)
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('shows a switch for booleans', () => {
    const { onChange } = setup(maintenance)
    const toggle = screen.getByRole('switch', { name: 'Maintenance mode' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('offers an Open link next to https urls only', () => {
    setup(termsUrl)
    const link = screen.getByRole('link', { name: 'Open Terms & conditions URL in a new tab' })
    expect(link).toHaveAttribute('href', 'https://guruconnect.in/terms')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('does not link a url that is not https yet', () => {
    setup(termsUrl, 'javascript:alert(1)')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('edits json as text: valid JSON becomes the value, invalid JSON is reported and clears once fixed', () => {
    const { onChange, onInvalid } = setup(domains)
    const box = screen.getByLabelText('Allowed banner link domains')
    expect(box).toHaveValue(JSON.stringify(['guruconnect.in'], null, 2))
    fireEvent.change(box, { target: { value: '["guruconnect.in", ' } })
    expect(onInvalid).toHaveBeenLastCalledWith('Enter valid JSON.')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: '["a.in","b.in"]' } })
    expect(onChange).toHaveBeenCalledWith(['a.in', 'b.in'])
    expect(onInvalid).toHaveBeenLastCalledWith(null)
  })

  it('greys out settings that are managed by deployments and says why', () => {
    setup(redirects)
    expect(screen.getByLabelText(/Blog redirects/)).toBeDisabled()
    expect(screen.getByText('Read-only')).toBeInTheDocument()
    expect(screen.getByText('This setting is managed by deployments.')).toBeInTheDocument()
  })

  it('disables the control for someone who may not edit', () => {
    setup(supportEmail, supportEmail.value, { disabled: true })
    expect(screen.getByLabelText('Support email')).toBeDisabled()
  })

  it('announces an error next to the control', () => {
    setup(supportEmail, 'x', { error: 'Enter a valid email address.' })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(screen.getByLabelText('Support email')).toHaveAttribute('aria-invalid', 'true')
  })
})
