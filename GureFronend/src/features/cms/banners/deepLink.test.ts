import { describe, expect, it } from 'vitest'
import { buildDeepLink, deepLinkProblem, emptyParts, parseDeepLink } from './deepLink'

const parts = (over: Partial<typeof emptyParts>) => ({ ...emptyParts, ...over })

describe('deep links', () => {
  it.each([
    ['gc://plans', 'plans'],
    ['gc://referral', 'referral'],
    ['gc://search?classId=10', 'search'],
    ['gc://blog/exam-tips', 'blog'],
    ['gc://teacher/2d7c9a4e-1b5f-4c3a-8a2e-9f0b1c2d3e4f', 'teacher'],
    ['https://guruconnect.in/offers', 'web'],
    [null, 'none'],
  ] as const)('reads %s as %s and builds the same link back', (link, kind) => {
    const read = parseDeepLink(link)
    expect(read.kind).toBe(kind)
    expect(buildDeepLink(read)).toBe(link)
  })

  it('opens an unrecognised link as a website link rather than dropping it', () => {
    expect(parseDeepLink('ftp://x')).toMatchObject({ kind: 'web', web: 'ftp://x' })
  })

  it('builds a bare search link when no filters are given', () => {
    expect(buildDeepLink(parts({ kind: 'search' }))).toBe('gc://search')
  })

  it.each([
    [parts({ kind: 'blog', blog: 'Bad Slug' }), 'Use the article’s slug, like exam-tips.'],
    [parts({ kind: 'teacher', teacher: '123' }), 'Paste the teacher’s id.'],
    [parts({ kind: 'web', web: 'http://guruconnect.in' }), 'Use an https:// link.'],
    [parts({ kind: 'web', web: 'offers' }), 'Use an https:// link.'],
    [parts({ kind: 'search', search: 'evil<script>' }), 'Use filters like classId=10&subjectId=maths.'],
  ])('flags a bad %j', (p, message) => {
    expect(deepLinkProblem(p)).toBe(message)
  })

  it('accepts good detail', () => {
    for (const p of [parts({ kind: 'blog', blog: 'exam-tips' }), parts({ kind: 'web', web: 'https://guruconnect.in' }), parts({ kind: 'search', search: 'classId=10&q=maths tutor' }), parts({ kind: 'search' }), parts({ kind: 'plans' })]) {
      expect(deepLinkProblem(p)).toBeNull()
    }
  })
})
