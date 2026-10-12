import { useId, useState } from 'react'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'
import type { Setting } from '../api/settings.api'

type Props = {
  setting: Setting
  value: unknown
  error?: string | null
  /** Read-only for people without settings.update; managed-by-deploy settings are always read-only. */
  disabled?: boolean
  onChange: (value: unknown) => void
  /** json settings: the text is not valid JSON yet, so there is no value to store. */
  onInvalid: (message: string | null) => void
}

const inputClass =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-fg-muted)]'

// One control per value type (FR-4.2). The label and help text are tied to the control so screen readers read them.
export function SettingInput({ setting, value, error, disabled, onChange, onInvalid }: Props) {
  const id = useId()
  const helpId = `${id}-help`
  const readOnly = disabled || !setting.isEditable
  const [jsonText, setJsonText] = useState(() => (setting.valueType === 'json' ? JSON.stringify(value, null, 2) : ''))

  const describedBy = [setting.description ? helpId : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined

  let control
  switch (setting.valueType) {
    case 'boolean':
      control = (
        <div className="mt-2">
          <StatusSwitch checked={value === true} label={setting.label} disabled={readOnly} onChange={onChange} />
        </div>
      )
      break
    case 'number':
      control = (
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={setting.constraints?.min}
          max={setting.constraints?.max}
          step={1}
          disabled={readOnly}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} h-10 max-w-40`}
        />
      )
      break
    case 'json':
      control = (
        <textarea
          id={id}
          rows={Math.min(10, Math.max(3, jsonText.split('\n').length))}
          spellCheck={false}
          disabled={readOnly}
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value)
            try {
              onChange(JSON.parse(e.target.value))
              onInvalid(null)
            } catch {
              onInvalid('Enter valid JSON.')
            }
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} py-2 font-[var(--font-mono)] text-[13px]`}
        />
      )
      break
    default:
      control = (
        <div className="flex items-center gap-2">
          <input
            id={id}
            type={setting.valueType === 'email' ? 'email' : 'text'}
            inputMode={setting.valueType === 'phone' ? 'tel' : undefined}
            disabled={readOnly}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={`${inputClass} h-10`}
          />
          {setting.valueType === 'url' && typeof value === 'string' && /^https:\/\//.test(value) ? (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${setting.label} in a new tab`}
              className="mt-1.5 flex h-10 flex-none items-center rounded-lg border border-[var(--color-border)] px-3 text-[13px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
            >
              Open
            </a>
          ) : null}
        </div>
      )
  }

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {setting.label}
        {!setting.isEditable ? <span className="ml-2 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">Read-only</span> : null}
      </label>
      {control}
      {setting.description ? (
        <p id={helpId} className="mt-1 text-xs text-[var(--color-fg-muted)]">
          {setting.description}
        </p>
      ) : null}
      {!setting.isEditable ? <p className="mt-1 text-xs text-[var(--color-fg-muted)]">This setting is managed by deployments.</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
