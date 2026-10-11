import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMe } from './api/auth.api'
import { authStore } from './authStore'
import { usePermissions } from './usePermissions'

vi.mock('./api/auth.api', () => ({ fetchMe: vi.fn() }))

const admin = { id: '1', email: 'a@b.co', fullName: 'A B', isSuperAdmin: false, avatarUrl: null }

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.mocked(fetchMe).mockReset()
  authStore.clear()
})

describe('usePermissions', () => {
  it('grants only the keys /auth/me lists', async () => {
    authStore.setSession('t', admin)
    vi.mocked(fetchMe).mockResolvedValue({ ...admin, roles: [], permissions: ['locations.read'], profile: { displayName: 'A', timezone: 'UTC', theme: 'light', avatarUrl: null } })
    const { result } = renderHook(() => usePermissions(), { wrapper })

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.can('locations.read')).toBe(true)
    expect(result.current.can('locations.manage')).toBe(false)
    expect(result.current.isSuperAdmin).toBe(false)
  })

  it('lets a super admin through every check without waiting for the list', () => {
    authStore.setSession('t', { ...admin, isSuperAdmin: true })
    vi.mocked(fetchMe).mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => usePermissions(), { wrapper })
    expect(result.current.can('anything.at.all')).toBe(true)
    expect(result.current.isSuperAdmin).toBe(true)
  })

  it('grants nothing when signed out and does not call the API', () => {
    const { result } = renderHook(() => usePermissions(), { wrapper })
    expect(result.current.can('locations.read')).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(fetchMe).not.toHaveBeenCalled()
  })
})
