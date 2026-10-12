import { describe, expect, it } from 'vitest'
import { groupLabel, needsReason, sameValue, validateSettingValue } from './validate'

const check = (valueType: Parameters<typeof validateSettingValue>[0]['valueType'], value: unknown, constraints?: { min: number; max: number }) => validateSettingValue({ valueType, constraints }, value)

describe('validateSettingValue', () => {
  it.each([
    ['string', 'GuruConnect', null],
    ['string', '   ', 'Enter 1–200 characters.'],
    ['string', 'x'.repeat(201), 'Enter 1–200 characters.'],
    ['string', 5, 'Enter 1–200 characters.'],
    ['email', 'help@guruconnect.in', null],
    ['email', 'help@', 'Enter a valid email address.'],
    ['phone', '+919876543210', null],
    ['phone', '9876543210', 'Enter a phone number like +919876543210.'],
    ['url', 'https://guruconnect.in/terms', null],
    ['url', 'http://guruconnect.in', 'Enter a link starting with https://'],
    ['url', 'terms', 'Enter a link starting with https://'],
    ['semver', '1.2.0', null],
    ['semver', '1.2', 'Enter a version like 1.2.0'],
    ['semver', 'v1.2.0', 'Enter a version like 1.2.0'],
    ['boolean', true, null],
    ['boolean', 'yes', 'Choose on or off.'],
    ['json', ['a'], null],
    ['json', undefined, 'Enter valid JSON.'],
  ] as const)('%s %j -> %s', (type, value, message) => {
    expect(check(type, value)).toBe(message)
  })

  it('checks a number against the key’s range and for whole numbers', () => {
    const range = { min: 1, max: 5 }
    expect(check('number', 3, range)).toBeNull()
    expect(check('number', 0, range)).toBe('Enter a number from 1 to 5.')
    expect(check('number', 6, range)).toBe('Enter a number from 1 to 5.')
    expect(check('number', 2.5, range)).toBe('Enter a whole number.')
    expect(check('number', null, range)).toBe('Enter a whole number.')
    expect(check('number', 999_999)).toBeNull()
  })
})

describe('helpers', () => {
  it('compares values structurally', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('names groups, falling back to a readable label', () => {
    expect(groupLabel('app_versions')).toBe('App versions')
    expect(groupLabel('feature_flags')).toBe('Feature flags')
  })

  it('asks for a reason on app.* keys only', () => {
    expect(needsReason('app.android_min_version')).toBe(true)
    expect(needsReason('contact.support_email')).toBe(false)
  })
})
