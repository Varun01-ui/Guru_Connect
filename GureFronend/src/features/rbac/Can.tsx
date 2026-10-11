import type { ReactNode } from 'react'
import { usePermissions } from '../auth/usePermissions'

// Renders its children only when the signed-in admin holds the permission (or any of them). The API stays the
// authority; this just avoids offering buttons it would refuse.
export function Can({ permission, anyOf, fallback = null, children }: { permission?: string; anyOf?: string[]; fallback?: ReactNode; children: ReactNode }) {
  const { can } = usePermissions()
  const allowed = permission ? can(permission) : (anyOf ?? []).some(can)
  return <>{allowed ? children : fallback}</>
}
