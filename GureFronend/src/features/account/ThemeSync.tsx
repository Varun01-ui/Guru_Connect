import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { applyTheme } from '../../lib/theme'
import { fetchMe } from '../auth/api/auth.api'
import { useAuth } from '../auth/authStore'

// Applies the signed-in admin's saved theme once their profile is known (and re-applies it when it changes).
export function ThemeSync() {
  const { admin } = useAuth()
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe, staleTime: 5 * 60_000, enabled: Boolean(admin) })
  const theme = me.data?.profile.theme
  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])
  return null
}
