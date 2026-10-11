import { useState } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'
import { inviteAdmin } from '../api/rbac.api'
import type { RoleSummary } from '../api/rbac.api'

type Props = {
  roles: RoleSummary[]
  onClose: () => void
  onInvited: (result: { email: string; inviteExpiresAt: string }) => void
}

const inputClass =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NAME = /^[\p{L}][\p{L} .'-]*$/u

export function InviteAdminDialog({ roles, onClose, onInvited }: Props) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleRole(id: string) {
    setRoleIds((current) => (current.includes(id) ? current.filter((r) => r !== id) : [...current, id]))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!EMAIL.test(email.trim()) || email.trim().length > 254) next.email = 'Enter a valid email address.'
    const trimmedName = fullName.trim()
    if (trimmedName.length < 2 || trimmedName.length > 100) next.fullName = 'Name must be 2–100 characters.'
    else if (!NAME.test(trimmedName)) next.fullName = "Name can contain letters, spaces, . ' and -."
    if (roleIds.length < 1 || roleIds.length > 5) next.roleIds = 'Choose 1–5 roles.'
    if (reason.trim() !== '' && (reason.trim().length < 5 || reason.trim().length > 500)) next.reason = 'Add a reason (5–500 characters).'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return

    setSaving(true)
    try {
      const result = await inviteAdmin({ email: email.trim(), fullName: trimmedName, roleIds, ...(reason.trim() ? { reason: reason.trim() } : {}) })
      onInvited({ email: result.email, inviteExpiresAt: result.inviteExpiresAt })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_DUPLICATE') setErrors({ email: e.message })
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
        const mapped: Record<string, string> = {}
        for (const d of e.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in mapped)) mapped[d.path] = d.message
        if (Object.keys(mapped).length > 0) setErrors(mapped)
        else setFormError(e.message)
      } else setFormError(e instanceof ApiError ? e.message : 'Could not send the invitation. Try again.')
      setSaving(false)
    }
  }

  const error = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
        {errors[key]}
      </p>
    ) : null

  return (
    <Modal title="Invite an admin" description="They get an email with a link to set their password. The link works for 72 hours." onClose={onClose} busy={saving}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label htmlFor="invite-email" className="text-sm font-medium">
            Email
          </label>
          <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus aria-invalid={errors.email ? true : undefined} className={`${inputClass} h-10`} placeholder="anjali@guruconnect.in" />
          {error('email')}
        </div>
        <div>
          <label htmlFor="invite-name" className="text-sm font-medium">
            Full name
          </label>
          <input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} aria-invalid={errors.fullName ? true : undefined} className={`${inputClass} h-10`} placeholder="Anjali Menon" />
          {error('fullName')}
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Roles (choose 1–5)</legend>
          <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
            {roles.map((r) => (
              <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]">
                <input type="checkbox" checked={roleIds.includes(r.id)} onChange={() => toggleRole(r.id)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                <span>
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-xs text-[var(--color-fg-muted)]">{r.permissionCount} permissions</span>
                </span>
              </label>
            ))}
          </div>
          {error('roleIds')}
        </fieldset>
        <div>
          <label htmlFor="invite-reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-muted)]">(needed for roles with sensitive permissions)</span>
          </label>
          <textarea id="invite-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={errors.reason ? true : undefined} className={`${inputClass} py-2`} placeholder="New verification hire" />
          {error('reason')}
        </div>

        {formError ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-60" disabled={saving}>
            {saving ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
