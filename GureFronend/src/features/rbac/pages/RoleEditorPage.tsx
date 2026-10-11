import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { createRole, deleteRole, fetchPermissionCatalogue, fetchRole, fetchRoles, patchRole, putRolePermissions } from '../api/rbac.api'
import type { PermissionGroup, RoleDetail } from '../api/rbac.api'
import { PermissionMatrix } from '../components/PermissionMatrix'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-fg-muted)]'
const primaryButton = 'rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60'
const secondaryButton = 'rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)] disabled:opacity-60'

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback)
const fieldErrors = (error: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (error instanceof ApiError && error.code === 'VALIDATION_FAILED' && Array.isArray(error.details)) {
    for (const d of error.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in out)) out[d.path] = d.message
  }
  return out
}

function usePermissionCatalogue() {
  return useQuery({ queryKey: ['rbac', 'permissions'], queryFn: fetchPermissionCatalogue, staleTime: 5 * 60_000 })
}
const sensitiveKeys = (catalogue: PermissionGroup[] | undefined) => new Set((catalogue ?? []).flatMap((g) => g.permissions.filter((p) => p.isSensitive).map((p) => p.key)))

function ReasonField({ id, value, onChange, error, keys }: { id: string; value: string; onChange: (v: string) => void; error?: string; keys: string[] }) {
  return (
    <div className="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] p-3">
      <label htmlFor={id} className="text-sm font-medium text-[var(--color-warn)]">
        Reason for granting sensitive permissions
      </label>
      <p className="text-xs text-[var(--color-warn)]">{keys.join(', ')}</p>
      <textarea id={id} rows={2} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} className={`${inputClass} py-2`} placeholder="Why does this role need them? (5–500 characters)" />
      {error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- create

function RoleCreateForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const catalogue = usePermissionCatalogue()
  const roles = useQuery({ queryKey: ['rbac', 'roles'], queryFn: fetchRoles })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const sensitive = sensitiveKeys(catalogue.data)
  const grantedSensitive = [...selected].filter((k) => sensitive.has(k)).sort()

  async function chooseCopy(roleId: string) {
    setCopyFrom(roleId)
    if (!roleId) return
    try {
      const source = await queryClient.fetchQuery({ queryKey: ['rbac', 'role', roleId], queryFn: () => fetchRole(roleId) })
      setSelected(new Set(source.permissionKeys))
    } catch (e) {
      setFormError(messageOf(e, 'Could not copy that role.'))
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (name.trim().length < 3 || name.trim().length > 50) next.name = 'Role name must be 3–50 characters.'
    if (description.trim().length > 250) next.description = 'Description can be up to 250 characters.'
    if (grantedSensitive.length > 0 && (reason.trim().length < 5 || reason.trim().length > 500)) next.reason = 'Add a reason (5–500 characters).'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return

    setSaving(true)
    try {
      const created = await createRole({ name: name.trim(), description: description.trim() || null, permissionKeys: [...selected], ...(grantedSensitive.length > 0 ? { reason: reason.trim() } : {}) })
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
      navigate(`/settings/roles/${created.id}`, { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_DUPLICATE') setErrors({ name: e.message })
      else {
        const mapped = fieldErrors(e)
        if (Object.keys(mapped).length > 0) setErrors(mapped)
        else setFormError(messageOf(e, 'Could not create the role. Try again.'))
      }
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link to="/settings/roles" className="text-sm text-[var(--color-accent)] hover:underline">
          ← Roles
        </Link>
        <h1 className="mt-2 text-xl font-semibold">New role</h1>
      </div>

      <section className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div>
          <label htmlFor="role-name" className="text-sm font-medium">
            Role name
          </label>
          <input id="role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} aria-invalid={errors.name ? true : undefined} className={`${inputClass} h-10`} placeholder="City Launch Admin" />
          {errors.name ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="role-description" className="text-sm font-medium">
            Description
          </label>
          <textarea id="role-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={250} aria-invalid={errors.description ? true : undefined} className={`${inputClass} py-2`} placeholder="Sets up masters and teachers for a new city" />
          {errors.description ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {errors.description}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="role-copy" className="text-sm font-medium">
            Start from an existing role
          </label>
          <select id="role-copy" value={copyFrom} onChange={(e) => void chooseCopy(e.target.value)} className={`${inputClass} h-10`}>
            <option value="">Start empty</option>
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Copies its permissions below; you can still change them.</p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Permissions ({selected.size} selected)</h2>
        {catalogue.isPending ? (
          <p className="text-sm text-[var(--color-fg-muted)]">Loading permissions…</p>
        ) : catalogue.isError ? (
          <p role="alert" className="text-sm text-[var(--color-bad)]">
            {messageOf(catalogue.error, 'Could not load the permissions.')}
          </p>
        ) : (
          <PermissionMatrix catalogue={catalogue.data} selected={selected} onChange={setSelected} />
        )}
      </section>

      {grantedSensitive.length > 0 ? <ReasonField id="role-reason" value={reason} onChange={setReason} error={errors.reason} keys={grantedSensitive} /> : null}
      {errors.permissionKeys ? (
        <p role="alert" className="text-sm text-[var(--color-bad)]">
          {errors.permissionKeys}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Link to="/settings/roles" className={secondaryButton}>
          Cancel
        </Link>
        <button type="submit" className={primaryButton} disabled={saving}>
          {saving ? 'Creating…' : 'Create role'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------------- edit

function RoleEditForm({ id }: { id: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const catalogue = usePermissionCatalogue()
  const role = useQuery({ queryKey: ['rbac', 'role', id], queryFn: () => fetchRole(id) })

  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null)
  const [keysDraft, setKeysDraft] = useState<Set<string> | null>(null)
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState<'details' | 'permissions' | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  if (role.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading role…</p>
  if (role.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{role.error instanceof ApiError && role.error.status === 404 ? 'This role no longer exists.' : messageOf(role.error, 'Could not load this role.')}</p>
        <Link to="/settings/roles" className="mt-3 inline-block font-medium text-[var(--color-accent)] hover:underline">
          Back to roles
        </Link>
      </div>
    )
  }

  const data: RoleDetail = role.data
  const isSuper = data.code === 'super_admin'
  const canManage = can('roles.manage')
  const readOnlyMatrix = !canManage || isSuper

  const name = nameDraft ?? data.name
  const description = descriptionDraft ?? data.description ?? ''
  const keys = keysDraft ?? new Set(data.permissionKeys)
  const detailsDirty = (nameDraft !== null && nameDraft.trim() !== data.name) || (descriptionDraft !== null && descriptionDraft.trim() !== (data.description ?? ''))
  const current = new Set(data.permissionKeys)
  const added = [...keys].filter((k) => !current.has(k)).sort()
  const removed = [...current].filter((k) => !keys.has(k)).sort()
  const sensitive = sensitiveKeys(catalogue.data)
  const addedSensitive = added.filter((k) => sensitive.has(k))

  function reset(next?: RoleDetail) {
    setNameDraft(null)
    setDescriptionDraft(null)
    setKeysDraft(null)
    setReason('')
    setErrors({})
    setConflict(null)
    setFormError(null)
    if (next) queryClient.setQueryData(['rbac', 'role', id], next)
  }

  function failed(e: unknown, fallback: string) {
    setNotice(null)
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setConflict(e.message)
      return
    }
    const mapped = fieldErrors(e)
    if (e instanceof ApiError && e.code === 'CONFLICT_DUPLICATE') setErrors({ name: e.message })
    else if (Object.keys(mapped).length > 0) setErrors(mapped)
    else setFormError(messageOf(e, fallback))
  }

  async function saveDetails() {
    const nextName = name.trim()
    const nextDescription = description.trim()
    const problems: Record<string, string> = {}
    if (!data.isSystem && (nextName.length < 3 || nextName.length > 50)) problems.name = 'Role name must be 3–50 characters.'
    if (nextDescription.length > 250) problems.description = 'Description can be up to 250 characters.'
    setErrors(problems)
    setFormError(null)
    if (Object.keys(problems).length > 0) return
    setSaving('details')
    try {
      const body: { name?: string; description?: string | null } = {}
      if (!data.isSystem && nextName !== data.name) body.name = nextName
      if (nextDescription !== (data.description ?? '')) body.description = nextDescription || null
      const updated = await patchRole(id, body, data.updatedAt)
      reset(updated)
      setNotice('Role details saved.')
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    } catch (e) {
      failed(e, 'Could not save the role. Try again.')
    } finally {
      setSaving(null)
    }
  }

  async function savePermissions() {
    if (addedSensitive.length > 0 && (reason.trim().length < 5 || reason.trim().length > 500)) {
      setErrors({ reason: 'Add a reason (5–500 characters).' })
      return
    }
    setErrors({})
    setFormError(null)
    setSaving('permissions')
    try {
      const updated = await putRolePermissions(id, [...keys], data.updatedAt, addedSensitive.length > 0 ? reason.trim() : undefined)
      reset(updated)
      setNotice('Permissions saved. Admins with this role pick them up within a few minutes.')
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    } catch (e) {
      failed(e, 'Could not save the permissions. Try again.')
    } finally {
      setSaving(null)
    }
  }

  async function reload() {
    reset()
    setNotice(null)
    await role.refetch()
  }

  async function remove() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteRole(id)
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
      navigate('/settings/roles', { replace: true })
    } catch (e) {
      setDeleteError(messageOf(e, 'Could not delete this role.'))
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link to="/settings/roles" className="text-sm text-[var(--color-accent)] hover:underline">
          ← Roles
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            {data.name}
            {data.isSystem ? <StatusBadge tone="info">System</StatusBadge> : null}
          </h1>
          {canManage && !data.isSystem ? (
            <button type="button" className="rounded-lg border border-[var(--color-bad)]/40 px-3.5 py-2 text-[13px] font-medium text-[var(--color-bad)] transition-colors hover:bg-[var(--color-bad-soft)]" onClick={() => setConfirmingDelete(true)}>
              Delete role
            </button>
          ) : null}
        </div>
      </div>

      {conflict ? (
        <div role="alert" className="rounded-lg bg-[var(--color-warn-soft)] px-3 py-2.5 text-sm text-[var(--color-warn)]">
          <p>{conflict}</p>
          <button type="button" className="mt-1.5 font-semibold underline" onClick={reload}>
            Reload latest
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-lg bg-[var(--color-good-soft)] px-3 py-2.5 text-sm text-[var(--color-good)]">
          {notice}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
          {formError}
        </p>
      ) : null}

      <section className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div>
          <label htmlFor="role-name" className="text-sm font-medium">
            Role name
          </label>
          <input
            id="role-name"
            value={name}
            maxLength={50}
            disabled={!canManage || data.isSystem}
            onChange={(e) => setNameDraft(e.target.value)}
            aria-invalid={errors.name ? true : undefined}
            className={`${inputClass} h-10`}
          />
          {data.isSystem ? <p className="mt-1 text-xs text-[var(--color-fg-muted)]">System roles can’t be renamed.</p> : null}
          {errors.name ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="role-description" className="text-sm font-medium">
            Description
          </label>
          <textarea id="role-description" rows={2} value={description} maxLength={250} disabled={!canManage} onChange={(e) => setDescriptionDraft(e.target.value)} aria-invalid={errors.description ? true : undefined} className={`${inputClass} py-2`} />
          {errors.description ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {errors.description}
            </p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButton} disabled={!detailsDirty || saving !== null} onClick={() => { setNameDraft(null); setDescriptionDraft(null); setErrors({}) }}>
              Discard
            </button>
            <button type="button" className={primaryButton} disabled={!detailsDirty || saving !== null} onClick={saveDetails}>
              {saving === 'details' ? 'Saving…' : 'Save details'}
            </button>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold">
          Permissions ({keys.size} selected)
        </h2>
        {isSuper ? <p className="mb-3 rounded-lg bg-[var(--color-info-soft)] px-3 py-2 text-sm text-[var(--color-info)]">Super Admin always has every permission.</p> : null}
        {!canManage && !isSuper ? <p className="mb-3 text-sm text-[var(--color-fg-muted)]">You can view this role but not change it.</p> : null}
        {catalogue.isPending ? (
          <p className="text-sm text-[var(--color-fg-muted)]">Loading permissions…</p>
        ) : catalogue.isError ? (
          <p role="alert" className="text-sm text-[var(--color-bad)]">
            {messageOf(catalogue.error, 'Could not load the permissions.')}
          </p>
        ) : (
          <PermissionMatrix catalogue={catalogue.data} selected={keys} onChange={setKeysDraft} readOnly={readOnlyMatrix} />
        )}

        {!readOnlyMatrix && (added.length > 0 || removed.length > 0) ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-[var(--color-fg-muted)]">
              {added.length > 0 ? `Adding ${added.length}` : null}
              {added.length > 0 && removed.length > 0 ? ', ' : null}
              {removed.length > 0 ? `removing ${removed.length}` : null} permission{added.length + removed.length === 1 ? '' : 's'}.
            </p>
            {addedSensitive.length > 0 ? <ReasonField id="permissions-reason" value={reason} onChange={setReason} error={errors.reason} keys={addedSensitive} /> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={secondaryButton} disabled={saving !== null} onClick={() => { setKeysDraft(null); setReason(''); setErrors({}) }}>
                Discard
              </button>
              <button type="button" className={primaryButton} disabled={saving !== null} onClick={savePermissions}>
                {saving === 'permissions' ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-semibold">Admins with this role ({data.admins.length})</h2>
        {data.admins.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">Nobody holds this role yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)]">
            {data.admins.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <Link to={`/settings/admins/${a.id}`} className="font-medium text-[var(--color-accent)] hover:underline">
                  {a.fullName}
                </Link>
                <span className="text-[var(--color-fg-muted)]">{a.email}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete ${data.name}?`}
          message={deleteError ?? 'The role disappears. Admins have to be taken off it first.'}
          confirmLabel={deleting ? 'Deleting…' : 'Delete role'}
          tone="danger"
          busy={deleting}
          onCancel={() => { setConfirmingDelete(false); setDeleteError(null) }}
          onConfirm={remove}
        />
      ) : null}
    </div>
  )
}

export function RoleEditorPage() {
  const { id } = useParams()
  return id ? <RoleEditForm key={id} id={id} /> : <RoleCreateForm />
}
