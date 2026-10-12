import { useMemo, useState } from 'react'
import { ApiError } from '../../../lib/api'
import { saveSettings } from '../api/settings.api'
import type { Setting, SettingGroup } from '../api/settings.api'
import { MAINTENANCE_KEY, needsReason, sameValue, validateSettingValue } from '../validate'
import { MaintenanceToggle } from './MaintenanceToggle'
import { SettingHistoryDrawer } from './SettingHistoryDrawer'
import { SettingInput } from './SettingInput'

type Props = {
  group: string
  settings: Setting[]
  canEdit: boolean
  /** Hides settings whose name or key does not contain this text; edits to hidden ones are kept. */
  filter?: string
  onSaved: (group: SettingGroup) => void
  onReload: () => void
}

// One tab = one form (FR-4.3). Only the changed keys are sent, together, so the save is all or nothing.
export function SettingsGroupForm({ group, settings, canEdit, filter = '', onSaved, onReload }: Props) {
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const [historyFor, setHistoryFor] = useState<Setting | null>(null)

  const valueOf = (s: Setting) => (s.key in drafts ? drafts[s.key] : s.value)
  const dirty = useMemo(() => settings.filter((s) => s.key in drafts && !sameValue(drafts[s.key], s.value)), [settings, drafts])
  const reasonNeeded = dirty.some((s) => needsReason(s.key))
  const needle = filter.trim().toLowerCase()
  const visible = settings.filter((s) => !needle || s.label.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle))

  const errorFor = (s: Setting): string | null => {
    if (jsonErrors[s.key]) return jsonErrors[s.key]!
    if (serverErrors[s.key]) return serverErrors[s.key]!
    return s.key in drafts && !sameValue(drafts[s.key], s.value) ? validateSettingValue(s, drafts[s.key]) : null
  }

  function change(s: Setting, value: unknown) {
    setDrafts((current) => ({ ...current, [s.key]: value }))
    setServerErrors(({ [s.key]: _gone, ...rest }) => rest)
    setFormError(null)
  }

  function discard() {
    setDrafts({})
    setJsonErrors({})
    setServerErrors({})
    setReason('')
    setMaintenanceConfirmed(false)
    setFormError(null)
    setStale(false)
  }

  async function save() {
    const problems = dirty.filter((s) => errorFor(s))
    const next: Record<string, string> = {}
    if (reasonNeeded && reason.trim().length < 5) next.reason = 'Add a reason for this change.'
    if (problems.length > 0 || next.reason) {
      setServerErrors(next)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const version = new Date(Math.max(...dirty.map((s) => new Date(s.updatedAt).getTime()))).toISOString()
      const turningOnMaintenance = dirty.some((s) => s.key === MAINTENANCE_KEY && drafts[s.key] === true)
      const result = await saveSettings(
        {
          group,
          values: Object.fromEntries(dirty.map((s) => [s.key, drafts[s.key]])),
          ...(reasonNeeded ? { reason: reason.trim() } : {}),
          ...(turningOnMaintenance && maintenanceConfirmed ? { confirmMaintenance: true } : {}),
        },
        version,
      )
      discard()
      onSaved(result.group)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setStale(true)
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
        const mapped: Record<string, string> = {}
        for (const d of e.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in mapped)) mapped[d.path] = d.message
        setServerErrors(mapped)
        if (!Object.keys(mapped).some((k) => k !== 'reason' && k !== 'confirmMaintenance')) setFormError(e.message)
      } else setFormError(e instanceof ApiError ? e.message : 'Could not save the settings. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (visible.length === 0) return <p className="px-1 py-6 text-sm text-[var(--color-fg-muted)]">No settings match your search.</p>

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      noValidate
      aria-label={`${group} settings`}
    >
      <div className="grid gap-6 md:grid-cols-2">
        {visible.map((s) => (
          <div key={s.key} className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${s.valueType === 'json' ? 'md:col-span-2' : ''}`}>
            {s.key === MAINTENANCE_KEY ? (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{s.label}</span>
                  <MaintenanceToggle
                    checked={valueOf(s) === true}
                    disabled={!canEdit || !s.isEditable}
                    onChange={(next) => {
                      change(s, next)
                      setMaintenanceConfirmed(next)
                    }}
                  />
                </div>
                {s.description ? <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{s.description}</p> : null}
                {errorFor(s) ? (
                  <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
                    {errorFor(s)}
                  </p>
                ) : null}
              </div>
            ) : (
              <SettingInput
                setting={s}
                value={valueOf(s)}
                error={errorFor(s)}
                disabled={!canEdit}
                onChange={(value) => change(s, value)}
                onInvalid={(message) => setJsonErrors((current) => (message ? { ...current, [s.key]: message } : (({ [s.key]: _gone, ...rest }) => rest)(current)))}
              />
            )}
            <div className="mt-2 flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
              <span>
                <code className="font-[var(--font-mono)]">{s.key}</code>
                {s.isPublic ? ' · public' : ''}
              </span>
              <button type="button" className="font-medium text-[var(--color-accent)] hover:underline" onClick={() => setHistoryFor(s)} aria-label={`History for ${s.label}`}>
                History
              </button>
            </div>
          </div>
        ))}
      </div>

      {stale ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
          <span>Settings changed since you opened this page. Reload.</span>
          <button type="button" className="rounded-lg border border-[var(--color-warn)]/40 px-3 py-1.5 font-semibold" onClick={onReload}>
            Reload latest
          </button>
        </div>
      ) : null}

      {canEdit && dirty.length > 0 ? (
        <div className="sticky bottom-4 mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-lg)]">
          {reasonNeeded ? (
            <div className="mb-3">
              <label htmlFor={`reason-${group}`} className="text-sm font-medium">
                Reason for this change
              </label>
              <input
                id={`reason-${group}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={serverErrors.reason ? true : undefined}
                placeholder="Security fix in 1.2.0"
                className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-bad)]"
              />
              {serverErrors.reason ? (
                <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
                  {serverErrors.reason}
                </p>
              ) : null}
            </div>
          ) : null}
          {formError ? (
            <p role="alert" className="mb-3 rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
              {formError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--color-fg-muted)]">
              {dirty.length} unsaved {dirty.length === 1 ? 'change' : 'changes'}
            </span>
            <div className="flex gap-2">
              <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]" disabled={saving} onClick={discard}>
                Discard
              </button>
              <button type="submit" className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyFor ? <SettingHistoryDrawer settingKey={historyFor.key} label={historyFor.label} onClose={() => setHistoryFor(null)} /> : null}
    </form>
  )
}
