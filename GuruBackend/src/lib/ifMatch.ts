import { validationFailed } from './errors.js'

// `If-Match: <updatedAt>` optimistic locking (mobile conventions §7). The value is the ISO timestamp the API
// returned; browsers/proxies may wrap it in quotes or a weak validator prefix, so both are tolerated.
export function parseIfMatch(header: string | undefined): Date {
  if (!header) throw validationFailed(undefined, 'Missing If-Match header.')
  const cleaned = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
  const date = new Date(cleaned)
  if (Number.isNaN(date.getTime())) throw validationFailed(undefined, 'If-Match must be the updatedAt value from the last response.')
  return date
}
