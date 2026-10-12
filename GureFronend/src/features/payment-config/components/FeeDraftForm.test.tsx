import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fieldsOf } from '../feeRules'
import { version } from '../testData'
import { FeeDraftForm } from './FeeDraftForm'

const show = (feeCode = 'PARENT_SUBSCRIPTION_YEARLY', over = {}, errors: Record<string, string> = {}, disabled = false) => {
  const onChange = vi.fn()
  render(<FeeDraftForm feeCode={feeCode} values={{ ...fieldsOf(version()), ...over }} errors={errors} disabled={disabled} onChange={onChange} />)
  return onChange
}

describe('FeeDraftForm', () => {
  it('shows the current values, with the price in rupees', () => {
    show()
    expect(screen.getByLabelText('Price')).toHaveValue('1999')
    expect(screen.getByLabelText('Display name')).toHaveValue('Parent membership · Yearly')
    expect(screen.getByLabelText('Validity (days)')).toHaveValue(365)
    expect(screen.getByLabelText('Free trial (days)')).toHaveValue(7)
    expect(screen.getByLabelText('GST rate')).toHaveValue('1800')
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
  })

  it('turns rupees typed into paise', () => {
    const onChange = show()
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '1,799.50' } })
    expect(onChange).toHaveBeenLastCalledWith({ amountPaise: 179950 })
  })

  it('rejects text that is not an amount, without reporting a change, and tidies the box on blur', () => {
    const onChange = show()
    const price = screen.getByLabelText('Price')
    fireEvent.change(price, { target: { value: '12.345' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount in rupees, like 1799 or 999.50.')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(price, { target: { value: '1799.5' } })
    fireEvent.blur(price)
    expect(price).toHaveValue('1799.50')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports the other fields', () => {
    const onChange = show()
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Parent plan' } })
    expect(onChange).toHaveBeenLastCalledWith({ name: 'Parent plan' })
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ description: null })
    fireEvent.change(screen.getByLabelText('Validity (days)'), { target: { value: '366' } })
    expect(onChange).toHaveBeenLastCalledWith({ validityDays: 366 })
    fireEvent.change(screen.getByLabelText('Free trial (days)'), { target: { value: '14' } })
    expect(onChange).toHaveBeenLastCalledWith({ trialDays: 14 })
    fireEvent.change(screen.getByLabelText('GST rate'), { target: { value: '1200' } })
    expect(onChange).toHaveBeenLastCalledWith({ gstRateBps: 1200 })
    fireEvent.click(screen.getByRole('switch', { name: 'Price includes GST' }))
    expect(onChange).toHaveBeenLastCalledWith({ gstInclusive: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    expect(onChange).toHaveBeenLastCalledWith({ isEnabled: false })
  })

  it('locks the billing period when the fee has only one', () => {
    show()
    expect(screen.getByLabelText('Billing period')).toBeDisabled()
    expect(screen.getByText('Fixed for this fee.')).toBeInTheDocument()
  })

  it('lets registration fees pick yearly or one time', () => {
    const onChange = show('TEACHER_REGISTRATION', { billingPeriod: 'yearly', trialDays: 0 })
    const period = screen.getByLabelText('Billing period')
    expect(period).toBeEnabled()
    expect(screen.getAllByRole('option').filter((o) => ['Yearly', 'One time'].includes(o.textContent ?? ''))).toHaveLength(2)
    fireEvent.change(period, { target: { value: 'one_time' } })
    expect(onChange).toHaveBeenLastCalledWith({ billingPeriod: 'one_time' })
  })

  it('hides the free trial for fees that are not memberships', () => {
    show('PREMIUM_TEACHER', { billingPeriod: 'per_30_days', validityDays: 30, trialDays: 0 })
    expect(screen.queryByLabelText('Free trial (days)')).toBeNull()
  })

  it('has no validity box for a per-use fee', () => {
    show('CONTACT_UNLOCK', { billingPeriod: 'per_use', validityDays: null, trialDays: 0 })
    expect(screen.getByLabelText('Validity (days)')).toBeDisabled()
    expect(screen.getByLabelText('Validity (days)')).toHaveValue(null)
  })

  it('shows errors under their fields', () => {
    show('PARENT_SUBSCRIPTION_YEARLY', {}, { amountPaise: 'Price must be between ₹0 and ₹1,00,000.', validityDays: 'Yearly plans last 365 or 366 days.' })
    expect(screen.getByText('Price must be between ₹0 and ₹1,00,000.')).toBeInTheDocument()
    expect(screen.getByText('Yearly plans last 365 or 366 days.')).toBeInTheDocument()
    expect(screen.getByLabelText('Price')).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables everything for someone who may not edit', () => {
    show('PARENT_SUBSCRIPTION_YEARLY', {}, {}, true)
    expect(screen.getByLabelText('Price')).toBeDisabled()
    expect(screen.getByLabelText('Display name')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled()
  })
})
