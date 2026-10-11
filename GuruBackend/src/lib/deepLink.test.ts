import { describe, expect, it } from 'vitest'
import { checkDeepLink } from './deepLink.js'

const domains = ['guruconnect.in']
const ok = (link: string) => checkDeepLink(link, domains).ok

describe('checkDeepLink', () => {
  it('accepts the registered app routes', () => {
    expect(ok('gc://plans')).toBe(true)
    expect(ok('gc://referral')).toBe(true)
    expect(ok('gc://search?subjectId=abc&classId=10')).toBe(true)
    expect(ok('gc://search?q=maths tutor')).toBe(true)
    expect(ok('gc://blog/how-to-pick-a-tutor')).toBe(true)
    expect(ok('gc://teacher/2d7c9a4e-1b5f-4c3a-8a2e-9f0b1c2d3e4f')).toBe(true)
  })

  it('rejects unknown routes, extra paths and unexpected parameters', () => {
    expect(ok('gc://wallet')).toBe(false)
    expect(ok('gc://plans/extra')).toBe(false)
    expect(ok('gc://plans?x=1')).toBe(false)
    expect(ok('gc://search?evil=1')).toBe(false)
    expect(ok('gc://search?q=<script>')).toBe(false)
    expect(ok('gc://blog/Bad Slug')).toBe(false)
    expect(ok('gc://teacher/123')).toBe(false)
    expect(ok('gc://user:pw@plans')).toBe(false)
    expect(ok('gc://')).toBe(false)
  })

  it('accepts https links on allow-listed domains and their subdomains', () => {
    expect(checkDeepLink('https://guruconnect.in/offers', domains)).toEqual({ ok: true, kind: 'web' })
    expect(ok('https://blog.guruconnect.in/post')).toBe(true)
    expect(ok('https://GURUCONNECT.IN')).toBe(true)
  })

  it('rejects look-alike hosts, http, credentials and other schemes', () => {
    expect(ok('https://evilguruconnect.in')).toBe(false)
    expect(ok('https://guruconnect.in.evil.com')).toBe(false)
    expect(ok('https://evil.com/?u=guruconnect.in')).toBe(false)
    expect(ok('https://guruconnect.in@evil.com')).toBe(false)
    expect(ok('http://guruconnect.in')).toBe(false)
    expect(ok('javascript:alert(1)')).toBe(false)
    expect(ok('intent://x')).toBe(false)
    expect(ok('')).toBe(false)
    expect(ok('guruconnect.in')).toBe(false)
  })
})
