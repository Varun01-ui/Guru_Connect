import { describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { parseIfMatch } from './ifMatch.js'
import { cdnUrl, maskEmail, maskPhone } from './present.js'

describe('maskPhone', () => {
  it('keeps the country code and first five digits', () => {
    expect(maskPhone('+919845014210')).toBe('+91 98450 XXXXX')
  })
  it('handles missing and non-standard numbers without leaking digits', () => {
    expect(maskPhone(null)).toBeNull()
    expect(maskPhone('')).toBeNull()
    expect(maskPhone('+1234567')).toBe('+12 XXXXX')
    expect(maskPhone('+1234567')).not.toContain('4567')
  })
})

describe('maskEmail', () => {
  it('shows the first and last character of the local part', () => {
    expect(maskEmail('lakshmi@gmail.com')).toBe('l***i@gmail.com')
  })
  it('never reveals short local parts', () => {
    expect(maskEmail('ab@x.in')).toBe('a***@x.in')
    expect(maskEmail('a@x.in')).toBe('a***@x.in')
  })
  it('returns null for missing or malformed addresses', () => {
    expect(maskEmail(null)).toBeNull()
    expect(maskEmail('not-an-email')).toBeNull()
    expect(maskEmail('@x.in')).toBeNull()
  })
})

describe('cdnUrl', () => {
  it('joins the CDN base and the object key', () => {
    expect(cdnUrl('avatars/a.jpg')).toBe(`${env.CDN_BASE_URL}/avatars/a.jpg`)
    expect(cdnUrl('/avatars/a.jpg')).toBe(cdnUrl('avatars/a.jpg'))
  })
  it('is null without a key', () => {
    expect(cdnUrl(null)).toBeNull()
    expect(cdnUrl(undefined)).toBeNull()
  })
})

describe('parseIfMatch', () => {
  it('parses a bare ISO timestamp, a quoted one and a weak validator', () => {
    const iso = '2026-09-20T11:00:00.000Z'
    expect(parseIfMatch(iso).toISOString()).toBe(iso)
    expect(parseIfMatch(`"${iso}"`).toISOString()).toBe(iso)
    expect(parseIfMatch(`W/"${iso}"`).toISOString()).toBe(iso)
    expect(parseIfMatch('2026-09-20T11:00:00Z').toISOString()).toBe(iso)
  })
  it('rejects a missing or unparseable header with VALIDATION_FAILED', () => {
    expect(() => parseIfMatch(undefined)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }))
    expect(() => parseIfMatch('nope')).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
  })
})
