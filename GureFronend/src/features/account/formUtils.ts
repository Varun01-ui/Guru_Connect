import { ApiError } from '../../lib/api'

export const inputClass =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:opacity-60'

export const primaryButton = 'rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60'
export const secondaryButton = 'rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-60'

export type FieldErrors = Record<string, string>

// Splits an API error into per-field messages (from `details`) and one message for the whole form.
export function readApiError(e: unknown, fallback: string): { fields: FieldErrors; form: string | null; conflict: boolean } {
  if (!(e instanceof ApiError)) return { fields: {}, form: fallback, conflict: false }
  const fields: FieldErrors = {}
  if (e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
    for (const d of e.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in fields)) fields[d.path] = d.message
  }
  const conflict = e.code === 'VERSION_CONFLICT'
  return { fields, form: Object.keys(fields).length > 0 ? null : e.message, conflict }
}
