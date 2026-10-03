import { authStore, getAccessToken } from '../features/auth/authStore'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1/admin'

export class ApiError extends Error {
  code: string
  status: number
  details?: unknown
  requestId?: string

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

type Envelope<T> = { data: T; meta?: Record<string, unknown> }
type ErrorEnvelope = {
  error: { code: string; message: string; details?: unknown; requestId?: string }
}

function readCsrfCookie(): string {
  const match = document.cookie.match(/(?:^|;\s*)gc_admin_csrf=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

let refreshInFlight: Promise<boolean> | null = null

export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': readCsrfCookie() },
      })
      if (!response.ok) return false
      const body = (await response.json()) as Envelope<{ accessToken: string; admin: Parameters<typeof authStore.setSession>[1] }>
      authStore.setSession(body.data.accessToken, body.data.admin)
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const send = () => {
    const token = getAccessToken()
    return fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
  }

  let response = await send()
  let body = (await response.json().catch(() => null)) as Envelope<T> | ErrorEnvelope | null

  if (response.status === 401 && retryOn401 && body && 'error' in body && body.error.code === 'AUTH_TOKEN_EXPIRED') {
    const refreshed = await refreshSession()
    if (refreshed) {
      response = await send()
      body = (await response.json().catch(() => null)) as Envelope<T> | ErrorEnvelope | null
    }
  }

  // Still unauthorised while we believed we were signed in (refresh failed, or the session was revoked elsewhere):
  // surface the "session ended" dialog instead of leaving the page half-working.
  if (response.status === 401 && body && 'error' in body && ['AUTH_TOKEN_EXPIRED', 'AUTH_REQUIRED'].includes(body.error.code)) {
    authStore.expire()
  }

  if (response.status === 204) return undefined as T

  if (!response.ok || !body || 'error' in body) {
    const err = body && 'error' in body ? body.error : undefined
    throw new ApiError(
      response.status,
      err?.code ?? 'INTERNAL_ERROR',
      err?.message ?? 'Something went wrong.',
      err?.details,
      err?.requestId,
    )
  }

  return body.data
}
