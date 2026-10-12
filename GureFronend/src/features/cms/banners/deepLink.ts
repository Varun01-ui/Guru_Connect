export type LinkKind = 'none' | 'search' | 'plans' | 'referral' | 'blog' | 'teacher' | 'web'

export const LINK_KINDS: { value: LinkKind; label: string }[] = [
  { value: 'none', label: 'No link' },
  { value: 'search', label: 'Search results' },
  { value: 'plans', label: 'Membership plans' },
  { value: 'referral', label: 'Refer & earn' },
  { value: 'blog', label: 'Blog article' },
  { value: 'teacher', label: 'A teacher’s profile' },
  { value: 'web', label: 'A website' },
]

export type LinkParts = { kind: LinkKind; search: string; blog: string; teacher: string; web: string }
export const emptyParts: LinkParts = { kind: 'none', search: '', blog: '', teacher: '', web: '' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Turns a stored deep link into the picker's fields. Anything it doesn't recognise opens as a website link so
// nothing is silently dropped.
export function parseDeepLink(link: string | null | undefined): LinkParts {
  if (!link) return emptyParts
  if (link === 'gc://plans') return { ...emptyParts, kind: 'plans' }
  if (link === 'gc://referral') return { ...emptyParts, kind: 'referral' }
  if (link.startsWith('gc://search')) return { ...emptyParts, kind: 'search', search: link.slice('gc://search'.length).replace(/^\?/, '') }
  if (link.startsWith('gc://blog/')) return { ...emptyParts, kind: 'blog', blog: link.slice('gc://blog/'.length) }
  if (link.startsWith('gc://teacher/')) return { ...emptyParts, kind: 'teacher', teacher: link.slice('gc://teacher/'.length) }
  return { ...emptyParts, kind: 'web', web: link }
}

export function buildDeepLink(parts: LinkParts): string | null {
  switch (parts.kind) {
    case 'none':
      return null
    case 'plans':
      return 'gc://plans'
    case 'referral':
      return 'gc://referral'
    case 'search':
      return parts.search.trim() ? `gc://search?${parts.search.trim()}` : 'gc://search'
    case 'blog':
      return `gc://blog/${parts.blog.trim()}`
    case 'teacher':
      return `gc://teacher/${parts.teacher.trim()}`
    case 'web':
      return parts.web.trim()
  }
}

// Instant feedback while typing; the server also checks the approved-domain list.
export function deepLinkProblem(parts: LinkParts): string | null {
  switch (parts.kind) {
    case 'blog':
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(parts.blog.trim()) ? null : 'Use the article’s slug, like exam-tips.'
    case 'teacher':
      return UUID.test(parts.teacher.trim()) ? null : 'Paste the teacher’s id.'
    case 'web':
      try {
        return new URL(parts.web.trim()).protocol === 'https:' ? null : 'Use an https:// link.'
      } catch {
        return 'Use an https:// link.'
      }
    case 'search':
      return /^([A-Za-z]+=[A-Za-z0-9 _.,-]{1,100}(&[A-Za-z]+=[A-Za-z0-9 _.,-]{1,100})*)?$/.test(parts.search.trim()) ? null : 'Use filters like classId=10&subjectId=maths.'
    default:
      return null
  }
}
