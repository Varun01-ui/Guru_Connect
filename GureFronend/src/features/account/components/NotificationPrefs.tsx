import { useState } from 'react'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'
import type { Profile, ProfilePatch } from '../api/account.api'
import { readApiError } from '../formUtils'

type Props = {
  profile: Profile
  busy: boolean
  onSave: (patch: ProfilePatch) => Promise<unknown>
  onConflict: () => void
}

const ROWS = [
  { key: 'email_digest', label: 'Daily email digest', help: 'A summary of the queues at 9 AM.' },
  { key: 'queue_alerts', label: 'Queue alerts', help: 'An email when a queue item passes its deadline.' },
] as const

// FR-3.5: the two editable alerts save as soon as they are flipped. Security alerts are always on.
export function NotificationPrefs({ profile, busy, onSave, onConflict }: Props) {
  const [error, setError] = useState<string | null>(null)

  async function flip(key: (typeof ROWS)[number]['key'], next: boolean) {
    setError(null)
    try {
      await onSave({ notificationPrefs: { [key]: next } })
    } catch (e) {
      const { form, conflict } = readApiError(e, 'Could not save your notification settings. Try again.')
      if (conflict) onConflict()
      setError(form)
    }
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)]">
        {ROWS.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-4 py-3">
            <div>
              <div className="text-sm font-medium">{row.label}</div>
              <div className="text-xs text-[var(--color-fg-muted)]">{row.help}</div>
            </div>
            <StatusSwitch checked={profile.notificationPrefs[row.key]} label={row.label} disabled={busy} onChange={(next) => void flip(row.key, next)} />
          </li>
        ))}
        <li className="flex items-center justify-between gap-4 py-3">
          <div>
            <div className="text-sm font-medium">Security alerts</div>
            <div className="text-xs text-[var(--color-fg-muted)]">Sign-in and password emails. Always on.</div>
          </div>
          <StatusSwitch checked label="Security alerts" disabled onChange={() => undefined} />
        </li>
      </ul>
      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
