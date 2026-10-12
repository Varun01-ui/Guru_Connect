import { useState } from 'react'
import type { Profile, ProfilePatch } from '../api/account.api'
import { inputClass, primaryButton, readApiError, secondaryButton } from '../formUtils'
import type { FieldErrors } from '../formUtils'

type Props = {
  profile: Profile
  busy: boolean
  onSave: (patch: ProfilePatch) => Promise<unknown>
  onConflict: () => void
}

const PHONE = /^\+[1-9]\d{6,14}$/
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ')

// FR-3.2: name, display name, designation and phone. Email and roles are shown but not editable here.
export function ProfileForm({ profile, busy, onSave, onConflict }: Props) {
  const start = { fullName: profile.fullName, displayName: profile.displayName ?? '', designation: profile.designation ?? '', phone: profile.phone ?? '' }
  const [values, setValues] = useState(start)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty = (Object.keys(start) as (keyof typeof start)[]).some((k) => collapse(values[k]) !== start[k])
  const set = (key: keyof typeof start) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [key]: e.target.value }))
    setSaved(false)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const next: FieldErrors = {}
    const name = collapse(values.fullName)
    if (name.length < 2 || name.length > 100) next.fullName = 'Name must be 2–100 characters.'
    const display = collapse(values.displayName)
    if (display !== '' && (display.length < 2 || display.length > 40)) next.displayName = 'Display name must be 2–40 characters.'
    if (collapse(values.designation).length > 80) next.designation = 'Designation can be up to 80 characters.'
    if (values.phone.trim() !== '' && !PHONE.test(values.phone.trim())) next.phone = 'Enter a phone number like +919876543210.'
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return

    const patch: ProfilePatch = {}
    if (name !== start.fullName) patch.fullName = name
    if (display !== start.displayName) patch.displayName = display === '' ? null : display
    if (collapse(values.designation) !== start.designation) patch.designation = collapse(values.designation) === '' ? null : collapse(values.designation)
    if (values.phone.trim() !== start.phone) patch.phone = values.phone.trim() === '' ? null : values.phone.trim()
    try {
      await onSave(patch)
      setSaved(true)
    } catch (e) {
      const { fields, form, conflict } = readApiError(e, 'Could not save your profile. Try again.')
      if (conflict) onConflict()
      setErrors(fields)
      setFormError(form)
    }
  }

  const error = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
        {errors[key]}
      </p>
    ) : null

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2" aria-label="Profile details">
      <div>
        <label htmlFor="acc-name" className="text-sm font-medium">
          Full name
        </label>
        <input id="acc-name" value={values.fullName} onChange={set('fullName')} aria-invalid={errors.fullName ? true : undefined} className={`${inputClass} h-10`} />
        {error('fullName')}
      </div>
      <div>
        <label htmlFor="acc-display" className="text-sm font-medium">
          Display name <span className="font-normal text-[var(--color-fg-muted)]">(optional)</span>
        </label>
        <input id="acc-display" value={values.displayName} onChange={set('displayName')} aria-invalid={errors.displayName ? true : undefined} className={`${inputClass} h-10`} />
        {error('displayName')}
      </div>
      <div>
        <label htmlFor="acc-designation" className="text-sm font-medium">
          Designation
        </label>
        <input id="acc-designation" value={values.designation} onChange={set('designation')} aria-invalid={errors.designation ? true : undefined} className={`${inputClass} h-10`} placeholder="Verification Lead" />
        {error('designation')}
      </div>
      <div>
        <label htmlFor="acc-phone" className="text-sm font-medium">
          Phone
        </label>
        <input id="acc-phone" type="tel" value={values.phone} onChange={set('phone')} aria-invalid={errors.phone ? true : undefined} className={`${inputClass} h-10`} placeholder="+919876543210" />
        {error('phone')}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="acc-email" className="text-sm font-medium">
          Email
        </label>
        <input id="acc-email" value={profile.email} readOnly disabled className={`${inputClass} h-10`} aria-describedby="acc-email-note" />
        <p id="acc-email-note" className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Your email is your sign-in. Ask a Super Admin to change it.
        </p>
      </div>

      {formError ? (
        <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)] sm:col-span-2">
          {formError}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-3 sm:col-span-2">
        {saved && !dirty ? (
          <span role="status" className="text-sm text-[var(--color-good)]">
            Saved
          </span>
        ) : null}
        <button
          type="button"
          className={secondaryButton}
          disabled={!dirty || busy}
          onClick={() => {
            setValues(start)
            setErrors({})
            setFormError(null)
          }}
        >
          Discard
        </button>
        <button type="submit" className={primaryButton} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  )
}
