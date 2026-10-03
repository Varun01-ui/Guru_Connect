import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { refreshSession } from '../../lib/api'
import { fetchMe } from './api/auth.api'
import { SessionExpiredDialog } from './components/SessionExpiredDialog'
import { authStore, useAuth } from './authStore'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  useEffect(() => {
    if (status !== 'loading') return
    let cancelled = false
    ;(async () => {
      const refreshed = await refreshSession()
      if (cancelled) return
      if (!refreshed) {
        authStore.clear()
        return
      }
      try {
        const me = await fetchMe()
        const token = authStore.getState().accessToken
        if (token) authStore.setSession(token, me)
      } catch {
        authStore.clear()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status])

  if (status === 'loading') {
    return <div className="p-8 text-sm opacity-70">Loading…</div>
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return (
    <>
      {children}
      {status === 'expired' ? <SessionExpiredDialog /> : null}
    </>
  )
}
