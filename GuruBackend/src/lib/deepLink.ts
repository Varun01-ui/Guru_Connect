// M44 FR-44.5: where a banner tap may lead. Either an app route from this registry, or an https link on a domain
// listed in the `banners.allowed_domains` setting (so a banner can't be used to send people to a phishing page).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SAFE_VALUE = /^[A-Za-z0-9 _.,-]{1,100}$/

export const SEARCH_PARAMS = ['subjectId', 'classId', 'boardId', 'cityId', 'areaId', 'modeId', 'q'] as const

export type DeepLinkCheck = { ok: true; kind: 'app' | 'web' } | { ok: false }

function checkAppRoute(link: string): boolean {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return false
  }
  if (url.protocol !== 'gc:') return false
  if (url.username || url.password || url.port || url.hash) return false
  const route = url.hostname.toLowerCase()
  const path = url.pathname.replace(/^\/+/, '')

  switch (route) {
    case 'plans':
    case 'referral':
      return path === '' && url.search === ''
    case 'search': {
      if (path !== '') return false
      for (const [key, value] of url.searchParams) {
        if (!(SEARCH_PARAMS as readonly string[]).includes(key) || !SAFE_VALUE.test(value)) return false
      }
      return true
    }
    case 'blog':
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(path) && url.search === ''
    case 'teacher':
      return new RegExp(`^${UUID}$`, 'i').test(path) && url.search === ''
    default:
      return false
  }
}

function checkWebLink(link: string, allowedDomains: string[]): boolean {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return allowedDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))
}

export function checkDeepLink(link: string, allowedDomains: string[]): DeepLinkCheck {
  const trimmed = link.trim()
  if (trimmed.startsWith('gc://')) return checkAppRoute(trimmed) ? { ok: true, kind: 'app' } : { ok: false }
  if (trimmed.startsWith('https://')) return checkWebLink(trimmed, allowedDomains) ? { ok: true, kind: 'web' } : { ok: false }
  return { ok: false }
}
