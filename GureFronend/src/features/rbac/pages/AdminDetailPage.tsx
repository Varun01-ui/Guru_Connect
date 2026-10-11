import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { useAuth } from '../../auth/authStore'
import { usePermissions } from '../../auth/usePermissions'
import { enableAdmin, fetchAdmin, fetchRoles, patchAdmin, resendInvite, revokeAllSessions } from '../api/rbac.api'
import type { AdminDetail } from '../api/rbac.api'
import { AdminStatusBadge } from '../components/AdminStatusBadge'
import { AssignRolesDialog } from '../components/AssignRolesDialog'
import { DisableAdminDialog } from '../components/DisableAdminDialog'

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback)
const button = 'rounded-lg border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  )
}

export function AdminDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { admin: me } = useAuth()
  const { can } = usePermissions()
  const canManage = can('admins.manage')

  const detail = useQuery({ queryKey: ['rbac', 'admin', id], queryFn: () => fetchAdmin(id) })
  const roles = useQuery({ queryKey: ['rbac', 'roles'], queryFn: fetchRoles, enabled: canManage })

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [dialog, setDialog] = useState<'disable' | 'delete' | null>(null)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (detail.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading admin…</p>
  if (detail.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{detail.error instanceof ApiError && detail.error.status === 404 ? 'This admin no longer exists.' : messageOf(detail.error, 'Could not load this admin.')}</p>
        <Link to="/settings/admins" className="mt-3 inline-block font-medium text-[var(--color-accent)] hover:underline">
          Back to admins
        </Link>
      </div>
    )
  }

  const admin: AdminDetail = detail.data
  const isSelf = me?.id === admin.id

  function store(updated: AdminDetail) {
    queryClient.setQueryData(['rbac', 'admin', id], updated)
    void queryClient.invalidateQueries({ queryKey: ['rbac', 'admins'] })
    void queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
  }

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (e) {
      setError(messageOf(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  async function saveName() {
    const next = nameDraft.trim()
    if (next.length < 2 || next.length > 100) {
      setNameError('Name must be 2–100 characters.')
      return
    }
    if (next === admin.fullName) {
      setEditingName(false)
      return
    }
    setNameError(null)
    setBusy(true)
    try {
      store(await patchAdmin(id, next, admin.updatedAt))
      setEditingName(false)
      setNotice('Name saved.')
    } catch (e) {
      setNameError(messageOf(e, 'Could not save the name.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link to="/settings/admins" className="text-sm text-[var(--color-accent)] hover:underline">
          ← Admins
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="admin-name" className="sr-only">
                Full name
              </label>
              <input
                id="admin-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                autoFocus
                maxLength={100}
                aria-invalid={nameError ? true : undefined}
                className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]"
              />
              <button type="button" className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60" disabled={busy} onClick={saveName}>
                Save name
              </button>
              <button type="button" className={button} disabled={busy} onClick={() => { setEditingName(false); setNameError(null) }}>
                Cancel
              </button>
              {nameError ? (
                <p role="alert" className="w-full text-xs text-[var(--color-bad)]">
                  {nameError}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <h1 className="text-xl font-semibold">{admin.fullName}</h1>
              {canManage ? (
                <button type="button" className="text-[13px] font-medium text-[var(--color-accent)] hover:underline" onClick={() => { setNameDraft(admin.fullName); setEditingName(true); setNotice(null) }}>
                  Edit name
                </button>
              ) : null}
            </>
          )}
          <AdminStatusBadge status={admin.status} />
          {admin.isSuperAdmin ? <StatusBadge tone="warn">Super Admin</StatusBadge> : null}
        </div>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{admin.email}</p>
      </div>

      {notice ? (
        <p role="status" className="rounded-lg bg-[var(--color-good-soft)] px-3 py-2.5 text-sm text-[var(--color-good)]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Fact label="Last sign-in">{admin.lastLoginAt ? formatDateTime(admin.lastLoginAt) : 'Never'}</Fact>
          <Fact label="Active sessions">{admin.sessionsCount}</Fact>
          <Fact label="Added">{formatDateTime(admin.createdAt)}</Fact>
          {admin.status === 'invited' && admin.inviteExpiresAt ? <Fact label="Invite expires">{formatDateTime(admin.inviteExpiresAt)}</Fact> : null}
        </dl>
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Roles</h2>
          {canManage ? (
            <button type="button" className={button} disabled={busy || roles.isPending} onClick={() => setAssigning(true)}>
              Change roles
            </button>
          ) : null}
        </div>
        {admin.roles.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">No roles yet, so this admin can’t do anything.</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {admin.roles.map((r) => (
              <li key={r.id}>
                <Link to={`/settings/roles/${r.id}`} className="inline-flex rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--color-accent)] hover:underline">
                  {r.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage || can('sessions.revoke_any') ? (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold">Access</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {canManage && admin.status === 'invited' ? (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await resendInvite(id)
                    await detail.refetch()
                    setNotice(`A new invitation was sent to ${result.email}. It works until ${formatDateTime(result.inviteExpiresAt)}.`)
                  }, 'Could not resend the invitation.')
                }
              >
                Resend invitation
              </button>
            ) : null}
            {canManage && admin.status === 'disabled' ? (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    store(await enableAdmin(id))
                    setNotice(`${admin.fullName} can sign in again.`)
                  }, 'Could not enable this admin.')
                }
              >
                Enable
              </button>
            ) : null}
            {can('sessions.revoke_any') && admin.sessionsCount > 0 ? (
              <button type="button" className={button} disabled={busy} onClick={() => setConfirmingSignOut(true)}>
                Sign out everywhere
              </button>
            ) : null}
            {canManage && admin.status !== 'disabled' && !isSelf ? (
              <button type="button" className="rounded-lg border border-[var(--color-bad)]/40 px-3.5 py-2 text-[13px] font-medium text-[var(--color-bad)] transition-colors hover:bg-[var(--color-bad-soft)] disabled:opacity-50" disabled={busy} onClick={() => setDialog('disable')}>
                Disable
              </button>
            ) : null}
            {canManage && admin.status === 'disabled' ? (
              <button type="button" className="rounded-lg border border-[var(--color-bad)]/40 px-3.5 py-2 text-[13px] font-medium text-[var(--color-bad)] transition-colors hover:bg-[var(--color-bad-soft)] disabled:opacity-50" disabled={busy} onClick={() => setDialog('delete')}>
                Delete
              </button>
            ) : null}
          </div>
          {isSelf ? <p className="mt-2 text-xs text-[var(--color-fg-muted)]">This is your own account, so you can’t disable or delete it.</p> : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-dashed border-[var(--color-border)] p-5">
        <h2 className="text-sm font-semibold">Audit trail</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Every change to this admin is recorded. The audit log viewer isn’t built yet, so the trail will appear here once it is.</p>
      </section>

      {assigning ? (
        <AssignRolesDialog
          admin={admin}
          roles={roles.data ?? []}
          onClose={() => setAssigning(false)}
          onSaved={(updated) => {
            store(updated)
            setAssigning(false)
            setNotice('Roles updated.')
          }}
        />
      ) : null}

      {dialog ? (
        <DisableAdminDialog
          mode={dialog}
          admin={admin}
          onClose={() => setDialog(null)}
          onDone={(mode, updated) => {
            setDialog(null)
            if (mode === 'delete') {
              void queryClient.invalidateQueries({ queryKey: ['rbac', 'admins'] })
              navigate('/settings/admins', { replace: true })
            } else if (updated) {
              store(updated)
              setNotice(`${admin.fullName} is disabled and signed out everywhere.`)
            }
          }}
        />
      ) : null}

      {confirmingSignOut ? (
        <ConfirmDialog
          title={`Sign ${admin.fullName} out everywhere?`}
          message="Every device they are signed in on is signed out. They can sign in again with their password."
          confirmLabel="Sign out"
          busy={busy}
          onCancel={() => setConfirmingSignOut(false)}
          onConfirm={() => {
            setConfirmingSignOut(false)
            void run(async () => {
              await revokeAllSessions(id)
              await detail.refetch()
              setNotice('Signed out of every device.')
            }, 'Could not sign this admin out.')
          }}
        />
      ) : null}
    </div>
  )
}
