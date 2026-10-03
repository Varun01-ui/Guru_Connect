import { useSyncExternalStore } from 'react'

export type AuthAdmin = {
  id: string
  email: string
  fullName: string
  isSuperAdmin: boolean
  avatarUrl: string | null
}

type AuthState = {
  // 'expired' = signed in earlier but the session can no longer be refreshed; the page stays put behind a dialog.
  status: 'loading' | 'authenticated' | 'expired' | 'anonymous'
  admin: AuthAdmin | null
  accessToken: string | null
}

let state: AuthState = { status: 'loading', admin: null, accessToken: null }
const listeners = new Set<() => void>()

function setState(partial: Partial<AuthState>) {
  state = { ...state, ...partial }
  listeners.forEach((listener) => listener())
}

export const authStore = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setSession(accessToken: string, admin: AuthAdmin) {
    setState({ status: 'authenticated', accessToken, admin })
  },
  expire() {
    if (state.status === 'authenticated') setState({ status: 'expired', accessToken: null })
  },
  clear() {
    setState({ status: 'anonymous', accessToken: null, admin: null })
  },
}

export function useAuth() {
  return useSyncExternalStore(authStore.subscribe, authStore.getState)
}

export function getAccessToken(): string | null {
  return state.accessToken
}
