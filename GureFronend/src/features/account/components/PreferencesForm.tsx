import { useState } from 'react'
import { applyTheme } from '../../../lib/theme'
import type { Profile, ProfilePatch } from '../api/account.api'
import { inputClass, primaryButton, readApiError } from '../formUtils'

type Props = {
  profile: Profile
  busy: boolean
  onSave: (patch: ProfilePatch) => Promise<unknown>
  onConflict: () => void
}

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match my device' },
] as const

// Zones the browser knows, with the common Indian default first.
const zones = (current: string) => {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const list = all.includes('Asia/Kolkata') ? all : ['Asia/Kolkata', ...all]
  return list.includes(current) ? list : [current, ...list]
}

// FR-3.2 / section 15: the theme applies the moment it is picked and is saved with it; time zone and language wait for Save.
export function PreferencesForm({ profile, busy, onSave, onConflict }: Props) {
  const [timezone, setTimezone] = useState(profile.timezone)
  const [locale, setLocale] = useState(profile.locale)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const dirty = timezone !== profile.timezone || locale !== profile.locale

  async function run(patch: ProfilePatch, onFail?: () => void) {
    setError(null)
    try {
      await onSave(patch)
      setSaved(true)
    } catch (e) {
      const { fields, form, conflict } = readApiError(e, 'Could not save your preferences. Try again.')
      if (conflict) onConflict()
      setError(fields.timezone ?? fields.locale ?? fields.theme ?? form)
      onFail?.()
    }
  }

  function pickTheme(theme: Profile['theme']) {
    const before = profile.theme
    applyTheme(theme)
    void run({ theme }, () => applyTheme(before))
  }

  return (
    <div>
      <fieldset className="mb-5">
        <legend className="text-sm font-medium">Theme</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <label
              key={t.value}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors ${
                profile.theme === t.value ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              <input type="radio" name="theme" value={t.value} checked={profile.theme === t.value} disabled={busy} onChange={() => pickTheme(t.value)} className="accent-[var(--color-accent)]" />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run({ ...(timezone !== profile.timezone ? { timezone } : {}), ...(locale !== profile.locale ? { locale } : {}) })
        }}
      >
        <div>
          <label htmlFor="acc-timezone" className="text-sm font-medium">
            Time zone
          </label>
          <select id="acc-timezone" value={timezone} onChange={(e) => { setTimezone(e.target.value); setSaved(false) }} className={`${inputClass} h-10`}>
            {zones(profile.timezone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Dates in the portal are shown in this time zone.</p>
        </div>
        <div>
          <label htmlFor="acc-locale" className="text-sm font-medium">
            Language
          </label>
          <select id="acc-locale" value={locale} onChange={(e) => { setLocale(e.target.value as Profile['locale']); setSaved(false) }} className={`${inputClass} h-10`}>
            <option value="en-IN">English (India)</option>
            <option value="hi-IN">हिन्दी</option>
          </select>
        </div>
        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)] sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-3 sm:col-span-2">
          {saved && !dirty ? (
            <span role="status" className="text-sm text-[var(--color-good)]">
              Saved
            </span>
          ) : null}
          <button type="submit" className={primaryButton} disabled={!dirty || busy}>
            Save preferences
          </button>
        </div>
      </form>
    </div>
  )
}
