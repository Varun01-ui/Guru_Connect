import { useState } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { authStore } from '../../auth/authStore'
import { PasswordStrength } from '../../auth/components/PasswordStrength'
import { isPasswordAcceptable } from '../../auth/passwordPolicy'
import { changePassword } from '../api/account.api'
import { inputClass, primaryButton, readApiError, secondaryButton } from '../formUtils'
import type { FieldErrors } from '../formUtils'

type Props = { email: string; fullName: string; onClose: () => void; onChanged: (result: { sessionsRevoked: number }) => void }

// FR-3.4. On success the server hands back a fresh access token (the old one carried the old password version),
// which replaces the one in memory so this tab stays signed in.
export function ChangePasswordDialog({ email, fullName, onClose, onChanged }: Props) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [signOutOthers, setSignOutOthers] = useState(true)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const problems: FieldErrors = {}
    if (current === '') problems.currentPassword = 'Enter your current password.'
    if (!isPasswordAcceptable(next, { email, fullName })) problems.newPassword = 'Your new password needs to meet every requirement below.'
    else if (next === current) problems.newPassword = "Choose a password you haven't used before."
    if (confirm !== next) problems.confirm = "The two passwords don't match."
    setErrors(problems)
    setFormError(null)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      const result = await changePassword({ currentPassword: current, newPassword: next, signOutOtherSessions: signOutOthers })
      const { admin } = authStore.getState()
      if (admin) authStore.setSession(result.accessToken, admin)
      onChanged({ sessionsRevoked: result.sessionsRevoked })
    } catch (e) {
      const { fields, form } = readApiError(e, 'Could not change your password. Try again.')
      const mapped: FieldErrors = { ...fields }
      if (!fields.newPassword && form && /current password/i.test(form)) {
        mapped.currentPassword = form
        setErrors(mapped)
      } else {
        setErrors(mapped)
        setFormError(Object.keys(fields).length === 0 ? form : null)
      }
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
    <Modal title="Change password" description="You'll stay signed in on this device." onClose={onClose} busy={saving}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label htmlFor="pw-current" className="text-sm font-medium">
            Current password
          </label>
          <input id="pw-current" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={errors.currentPassword ? true : undefined} className={`${inputClass} h-10`} />
          {error('currentPassword')}
        </div>
        <div>
          <label htmlFor="pw-new" className="text-sm font-medium">
            New password
          </label>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={errors.newPassword ? true : undefined} className={`${inputClass} h-10`} />
          {error('newPassword')}
          <div className="mt-2">
            <PasswordStrength password={next} email={email} fullName={fullName} />
          </div>
        </div>
        <div>
          <label htmlFor="pw-confirm" className="text-sm font-medium">
            Confirm new password
          </label>
          <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={errors.confirm ? true : undefined} className={`${inputClass} h-10`} />
          {error('confirm')}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Sign out of my other devices
        </label>

        {formError ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={secondaryButton} disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryButton} disabled={saving}>
            {saving ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
