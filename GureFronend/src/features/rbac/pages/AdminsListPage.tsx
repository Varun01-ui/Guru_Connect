import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DataTable } from '../../../components/shared/DataTable'
import type { DataTableColumn } from '../../../components/shared/DataTable'
import { Pagination } from '../../../components/shared/Pagination'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { useDebouncedValue } from '../../../lib/useDebouncedValue'
import { usePermissions } from '../../auth/usePermissions'
import { fetchAdmins, fetchRoles } from '../api/rbac.api'
import type { AdminListParams, AdminRow, AdminStatus } from '../api/rbac.api'
import { AdminStatusBadge } from '../components/AdminStatusBadge'
import { InviteAdminDialog } from '../components/InviteAdminDialog'

const selectClass = 'h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)]'

const columns: DataTableColumn<AdminRow>[] = [
  {
    id: 'admin',
    header: 'Admin',
    cell: (a) => (
      <span className="flex flex-col">
        <Link to={`/settings/admins/${a.id}`} className="font-medium text-[var(--color-accent)] hover:underline">
          {a.fullName}
        </Link>
        <span className="text-xs text-[var(--color-fg-muted)]">{a.email}</span>
      </span>
    ),
  },
  {
    id: 'roles',
    header: 'Roles',
    cell: (a) => (
      <span className="flex flex-wrap gap-1.5">
        {a.isSuperAdmin ? <StatusBadge tone="warn">Super Admin</StatusBadge> : null}
        {a.roles.filter((r) => r.code !== 'super_admin').map((r) => (
          <StatusBadge key={r.id}>{r.name}</StatusBadge>
        ))}
        {!a.isSuperAdmin && a.roles.length === 0 ? <span className="text-xs text-[var(--color-fg-muted)]">No roles</span> : null}
      </span>
    ),
  },
  { id: 'status', header: 'Status', cell: (a) => <AdminStatusBadge status={a.status} /> },
  { id: 'lastLogin', header: 'Last sign-in', cell: (a) => (a.lastLoginAt ? formatDateTime(a.lastLoginAt) : <span className="text-[var(--color-fg-muted)]">Never</span>) },
]

export function AdminsListPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<AdminStatus | ''>('')
  const [roleId, setRoleId] = useState('')
  const [lastLogin, setLastLogin] = useState<'' | 'never' | 'stale30'>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [inviting, setInviting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const q = useDebouncedValue(search.trim(), 300)
  const params: AdminListParams = {
    page,
    pageSize,
    q: q.length >= 2 ? q : undefined, // the API searches from 2 characters
    status: status || undefined,
    roleId: roleId || undefined,
    lastLogin: lastLogin || undefined,
  }
  const list = useQuery({ queryKey: ['rbac', 'admins', params], queryFn: () => fetchAdmins(params), placeholderData: keepPreviousData })
  const roles = useQuery({ queryKey: ['rbac', 'roles'], queryFn: fetchRoles })
  const filtered = Boolean(params.q) || Boolean(status) || Boolean(roleId) || Boolean(lastLogin)

  function filter(apply: () => void) {
    apply()
    setPage(1)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Admins</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">Everyone who can sign in to this portal, and the roles that decide what they can do.</p>
        </div>
        {can('admins.manage') ? (
          <button
            type="button"
            className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)]"
            onClick={() => {
              setNotice(null)
              setInviting(true)
            }}
          >
            Invite admin
          </button>
        ) : null}
      </div>

      <section className="mt-6 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <input
            type="search"
            value={search}
            onChange={(e) => filter(() => setSearch(e.target.value))}
            placeholder="Search by name or email"
            aria-label="Search admins"
            className="h-10 min-w-[16rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            Status
            <select value={status} onChange={(e) => filter(() => setStatus(e.target.value as AdminStatus | ''))} className={selectClass}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="locked">Locked</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            Role
            <select value={roleId} onChange={(e) => filter(() => setRoleId(e.target.value))} className={selectClass}>
              <option value="">All roles</option>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            Last sign-in
            <select value={lastLogin} onChange={(e) => filter(() => setLastLogin(e.target.value as '' | 'never' | 'stale30'))} className={selectClass}>
              <option value="">Any time</option>
              <option value="never">Never</option>
              <option value="stale30">More than 30 days ago</option>
            </select>
          </label>
        </div>

        {notice ? (
          <p role="status" className="border-t border-[var(--color-border)] bg-[var(--color-good-soft)] px-4 py-2.5 text-sm text-[var(--color-good)]">
            {notice}
          </p>
        ) : null}

        <div className="border-t border-[var(--color-border)]">
          <DataTable
            label="Admins"
            columns={columns}
            rows={list.data?.data ?? []}
            rowKey={(a) => a.id}
            isLoading={list.isPending}
            loadingText="Loading admins…"
            isRefreshing={list.isPlaceholderData}
            errorMessage={list.isError && !list.data ? (list.error instanceof ApiError ? list.error.message : 'Could not load the admins.') : null}
            onRetry={() => list.refetch()}
            emptyText={filtered ? 'No admins match your filters.' : 'No admins yet.'}
          />
        </div>

        {list.data && list.data.meta.total > 0 ? (
          <Pagination page={list.data.meta.page} pageSize={list.data.meta.pageSize} total={list.data.meta.total} totalPages={list.data.meta.totalPages} onPage={setPage} onPageSize={(size) => filter(() => setPageSize(size))} />
        ) : null}
      </section>

      {inviting ? (
        <InviteAdminDialog
          roles={roles.data ?? []}
          onClose={() => setInviting(false)}
          onInvited={(result) => {
            setInviting(false)
            setNotice(`Invitation sent to ${result.email}. The link works until ${formatDateTime(result.inviteExpiresAt)}.`)
            void queryClient.invalidateQueries({ queryKey: ['rbac', 'admins'] })
          }}
        />
      ) : null}
    </div>
  )
}
