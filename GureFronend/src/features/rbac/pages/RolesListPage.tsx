import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchRoles } from '../api/rbac.api'
import { RoleCard } from '../components/RoleCard'

export function RolesListPage() {
  const { can } = usePermissions()
  const [filter, setFilter] = useState('')
  const roles = useQuery({ queryKey: ['rbac', 'roles'], queryFn: fetchRoles })

  const term = filter.trim().toLowerCase()
  const shown = (roles.data ?? []).filter((r) => !term || r.name.toLowerCase().includes(term) || (r.description ?? '').toLowerCase().includes(term))

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Roles</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">A role is a named set of permissions. Give an admin one or more roles to decide what they can see and change.</p>
        </div>
        {can('roles.manage') ? (
          <Link to="/settings/roles/new" className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)]">
            New role
          </Link>
        ) : null}
      </div>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter roles"
        aria-label="Filter roles"
        className="mt-6 h-10 w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
      />

      {roles.isPending ? (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">Loading roles…</p>
      ) : roles.isError ? (
        <div role="alert" className="mt-6 text-sm">
          <p className="text-[var(--color-bad)]">{roles.error instanceof ApiError ? roles.error.message : 'Could not load roles.'}</p>
          <button type="button" className="mt-3 font-medium text-[var(--color-accent)] hover:underline" onClick={() => roles.refetch()}>
            Try again
          </button>
        </div>
      ) : shown.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">{term ? 'No roles match your filter.' : 'No roles yet.'}</p>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((role) => (
            <RoleCard key={role.id} role={role} />
          ))}
        </div>
      )}
    </div>
  )
}
