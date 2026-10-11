import { Link } from 'react-router-dom'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import type { RoleSummary } from '../api/rbac.api'

export function RoleCard({ role }: { role: RoleSummary }) {
  return (
    <Link
      to={`/settings/roles/${role.id}`}
      className="group flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm transition-colors hover:border-[var(--color-accent)]"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold group-hover:text-[var(--color-accent)]">{role.name}</h2>
        {role.isSystem ? <StatusBadge tone="info">System</StatusBadge> : null}
      </div>
      <p className="mt-1.5 line-clamp-2 min-h-[2.5rem] text-sm text-[var(--color-fg-muted)]">{role.description ?? 'No description.'}</p>
      <dl className="mt-4 flex gap-6 border-t border-[var(--color-border)] pt-3 text-sm">
        <div>
          <dt className="text-xs text-[var(--color-fg-muted)]">Permissions</dt>
          <dd className="font-semibold">{role.permissionCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--color-fg-muted)]">Admins</dt>
          <dd className="font-semibold">{role.adminCount}</dd>
        </div>
      </dl>
    </Link>
  )
}
