import { useQuery } from '@tanstack/react-query'
import { fetchMe } from './api/auth.api'
import { useAuth } from './authStore'

// Permission keys of the signed-in admin, from GET /auth/me (cached 5 min, like the server's own cache).
// Super admins pass every check. The UI only hides what the API would refuse anyway; the API stays the authority.
export function usePermissions() {
  const { admin } = useAuth()
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe, staleTime: 5 * 60_000, enabled: Boolean(admin) })
  const held = new Set(me.data?.permissions ?? [])
  return {
    isLoading: me.isPending && Boolean(admin),
    isSuperAdmin: Boolean(admin?.isSuperAdmin),
    can: (key: string) => Boolean(admin?.isSuperAdmin) || held.has(key),
  }
}
