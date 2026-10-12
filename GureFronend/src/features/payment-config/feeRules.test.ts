import { describe, expect, it } from 'vitest'
import { diffFields, feeLabel, fieldProblems, fieldsOf, isLargeChange, priceChangePercent } from './feeRules'
import { version } from './testData'

const fields = (over = {}) => ({ ...fieldsOf(version()), ...over })

describe('fieldProblems', () => {
  it('accepts a valid yearly membership', () => {
    expect(fieldProblems('PARENT_SUBSCRIPTION_YEARLY', fields())).toEqual({})
  })

  it.each([
    ['PARENT_SUBSCRIPTION_YEARLY', { name: 'ab' }, 'name', 'Name must be 3–60 characters.'],
    ['PARENT_SUBSCRIPTION_YEARLY', { description: 'x'.repeat(201) }, 'description', 'Description can be up to 200 characters.'],
    ['PARENT_SUBSCRIPTION_YEARLY', { amountPaise: -1 }, 'amountPaise', 'Price must be between ₹0 and ₹1,00,000.'],
    ['PARENT_SUBSCRIPTION_YEARLY', { amountPaise: 10_000_001 }, 'amountPaise', 'Price must be between ₹0 and ₹1,00,000.'],
    ['PARENT_SUBSCRIPTION_YEARLY', { trialDays: 91 }, 'trialDays', 'Trial must be 0–90 days.'],
    ['PREMIUM_TEACHER', { billingPeriod: 'per_30_days', validityDays: 30, trialDays: 7 }, 'trialDays', 'Only membership plans can have a free trial.'],
    ['PARENT_SUBSCRIPTION_YEARLY', { validityDays: 300 }, 'validityDays', 'Yearly plans last 365 or 366 days.'],
    ['PARENT_SUBSCRIPTION_MONTHLY', { billingPeriod: 'monthly', validityDays: 40 }, 'validityDays', 'Monthly plans last 28–31 days.'],
    ['PREMIUM_TEACHER', { billingPeriod: 'per_30_days', validityDays: 31, trialDays: 0 }, 'validityDays', 'This listing lasts 30 days.'],
    ['PREMIUM_TEACHER', { billingPeriod: 'per_30_days', validityDays: null, trialDays: 0 }, 'validityDays', 'Enter how many days the purchase lasts.'],
    ['PREMIUM_TEACHER', { billingPeriod: 'per_30_days', validityDays: 2000, trialDays: 0 }, 'validityDays', 'Validity must be 1–1,095 days.'],
    ['CONTACT_UNLOCK', { billingPeriod: 'per_use', validityDays: 30, trialDays: 0 }, 'validityDays', 'Contact unlock has no validity period.'],
  ])('%s %j -> %s', (fee, over, key, message) => {
    expect(fieldProblems(fee, fields(over))[key]).toBe(message)
  })

  it('accepts a per-use fee with no validity', () => {
    expect(fieldProblems('CONTACT_UNLOCK', fields({ billingPeriod: 'per_use', validityDays: null, trialDays: 0 }))).toEqual({})
  })
})

describe('helpers', () => {
  it('diffs only the fields that differ', () => {
    const was = fields()
    expect(diffFields(was, was)).toEqual({})
    expect(diffFields({ ...was, amountPaise: 179900, description: null }, was)).toEqual({ amountPaise: 179900, description: null })
  })

  it('works out the price change and when it needs confirming', () => {
    expect(priceChangePercent(199900, 179900)).toBe(-10)
    expect(priceChangePercent(0, 100)).toBeNull()
    expect(isLargeChange(100, 150)).toBe(false)
    expect(isLargeChange(100, 151)).toBe(true)
    expect(isLargeChange(100, 40)).toBe(true)
    expect(isLargeChange(0, 5000)).toBe(false)
  })

  it('labels fee codes, falling back to the code', () => {
    expect(feeLabel('PREMIUM_TEACHER')).toBe('Premium teacher listing')
    expect(feeLabel('MYSTERY')).toBe('MYSTERY')
  })
})
