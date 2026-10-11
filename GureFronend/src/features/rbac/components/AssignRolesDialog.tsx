import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'
import { fetchRole, putAdminRoles } from '../api/rbac.api'
import type { AdminDetail, RoleDetail, RoleSummary } from '../api/rbac.api'

type Props = {
  admin: AdminDetail
  roles: RoleSummary[]
  onClose: () => void
  onSaved: (admin: AdminDetail) => void
}

const union = (details: RoleDetail[]) => new Set(details.flatMap((d) => d.permissionKeys))

function KeyList({ title, keys, tone }: { title: string; keys: string[]; tone: 'good' | 'bad' }) {
  if (keys.length === 0) return null
  return (
    <div>
      <p className={`text-xs font-semibold ${tone === 'good' ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}`}>
        {title} ({keys.length})
      </p>
      <p className="mt-0.5 break-words font-mono text-xs text-[var(--color-fg-muted)]">{keys.join(', ')}</p>
    </div>
  )
}

// Changing someone's roles shows what they will gain and lose before it is saved (section 15).
export function AssignRolesDialog({ admin, roles, onClose, onSaved }: Props) {
  const [roleIds, setRoleIds] = useState(admin.roles.map((r) => r.id))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const before = admin.roles.map((r) => r.id)
  const involved = [...new Set([...before, ...roleIds])]
  const details = useQueries({ queries: involved.map((id) => ({ queryKey: ['rbac', 'role', id], queryFn: () => fetchRole(id), staleTime: 60_000 })) })
  const loaded = details.every((d) => d.data)
  const byId = new Map(details.flatMap((d) => (d.data ? [[d.data.id, d.data] as const] : [])))
  const oldKeys = union(before.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])))
  const newKeys = union(roleIds.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])))
  const gains = [...newKeys].filter((k) => !oldKeys.has(k)).sort()
  const losses = [...oldKeys].filter((k) => !newKeys.has(k)).sort()
  const changed = roleIds.length !== before.length || roleIds.some((id) => !before.includes(id))

  function toggle(id: string) {
    setRoleIds((current) => (current.includes(id) ? current.filter((r) => r !== id) : [...current, id]))
  }

  async function save() {
    setError(null)
    setReasonError(null)
    if (roleIds.length < 1 || roleIds.length > 5) {
      setError('Choose 1–5 roles.')
      return
    }
    if (reason.trim() !== '' && (reason.trim().length < 5 || reason.trim().length > 500)) {
      setReasonError('Add a reason (5–500 characters).')
      return
    }
    setSaving(true)
    try {
      onSaved(await putAdminRoles(admin.id, roleIds, reason.trim() || undefined))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details) && (e.details as { path?: string }[]).some((d) => d.path === 'reason')) {
        setReasonError(e.message)
      } else setError(e instanceof ApiError ? e.message : 'Could not change the roles. Try again.')
      setSaving(false)
    }
  }

  return (
    <Modal title={`Roles for ${admin.fullName}`} description="Choose 1–5 roles. Their permissions combine." onClose={onClose} busy={saving}>
      <div className="space-y-4">
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
          {roles.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]">
              <input type="checkbox" checked={roleIds.includes(r.id)} onChange={() => toggle(r.id)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="block text-xs text-[var(--color-fg-muted)]">{r.permissionCount} permissions</span>
              </span>
            </label>
          ))}
        </div>

        <div aria-live="polite" className="rounded-lg bg-[var(--color-surface-2)] p-3 text-sm">
          {!changed ? (
            <p className="text-[var(--color-fg-muted)]">No change yet.</p>
          ) : !loaded ? (
            <p className="text-[var(--color-fg-muted)]">Working out what changes…</p>
          ) : gains.length === 0 && losses.length === 0 ? (
            <p className="text-[var(--color-fg-muted)]">Their permissions stay exactly the same.</p>
          ) : (
            <div className="space-y-2">
              <KeyList title="Gains" keys={gains} tone="good" />
              <KeyList title="Loses" keys={losses} tone="bad" />
            </div>
          )}
        </div>

        <div>
          <label htmlFor="assign-reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-muted)]">(needed when they gain sensitive permissions)</span>
          </label>
          <textarea
            id="assign-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonError ? true : undefined}
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]"
          />
          {reasonError ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {reasonError}
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-60" disabled={saving || !changed} onClick={save}>
            {saving ? 'Saving…' : 'Save roles'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
