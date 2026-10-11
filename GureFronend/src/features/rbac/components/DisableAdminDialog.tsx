import { useState } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'
import { deleteAdmin, disableAdmin } from '../api/rbac.api'
import type { AdminDetail } from '../api/rbac.api'

type Props = {
  mode: 'disable' | 'delete'
  admin: AdminDetail
  onClose: () => void
  onDone: (mode: 'disable' | 'delete', updated: AdminDetail | null) => void
}

// Disabling signs the admin out everywhere; deleting removes a disabled admin. Both need a written reason, which goes
// to the audit log.
export function DisableAdminDialog({ mode, admin, onClose, onDone }: Props) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const verb = mode === 'disable' ? 'Disable' : 'Delete'

  async function confirm() {
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      setError('Add a reason (5–500 characters).')
      return
    }
    setError(null)
    setSaving(true)
    try {
      if (mode === 'disable') onDone(mode, await disableAdmin(admin.id, reason.trim()))
      else {
        await deleteAdmin(admin.id, reason.trim())
        onDone(mode, null)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Could not ${mode} this admin. Try again.`)
      setSaving(false)
    }
  }

  return (
    <Modal
      size="sm"
      title={`${verb} ${admin.fullName}?`}
      description={mode === 'disable' ? 'They are signed out of every device and can’t sign in until you enable them again.' : 'This removes the admin for good. Their past actions stay in the audit log.'}
      onClose={onClose}
      busy={saving}
    >
      <label htmlFor="disable-reason" className="text-sm font-medium">
        Reason
      </label>
      <textarea
        id="disable-reason"
        rows={3}
        value={reason}
        autoFocus
        onChange={(e) => setReason(e.target.value)}
        aria-invalid={error ? true : undefined}
        className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]"
        placeholder="Left the company on 30 Sep"
      />
      {error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="rounded-lg bg-[var(--color-bad)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60" disabled={saving} onClick={confirm}>
          {saving ? `${verb === 'Disable' ? 'Disabling' : 'Deleting'}…` : verb}
        </button>
      </div>
    </Modal>
  )
}
