import { useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'

/** Throw from onSubmit when the caller has already shown the problem itself. */
export class HandledError extends Error {}

type Props = {
  title: string
  description?: string
  confirmLabel: string
  tone?: 'default' | 'danger'
  /** Extra content above the reason box (an impact summary, for example). */
  children?: ReactNode
  /** Resolve to close the dialog; throw (an ApiError) to keep it open with the message. */
  onSubmit: (reason: string, confirmLargeChange: boolean) => Promise<void>
  onClose: () => void
}

// Every price-changing action asks for a reason (5–500 characters), which lands in the change history.
export function ReasonDialog({ title, description, confirmLabel, tone = 'default', children, onSubmit, onClose }: Props) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = reason.trim()
    if (trimmed.length < 5 || trimmed.length > 500) return setReasonError('Add a reason (5–500 characters).')
    if (needsConfirm && !confirmed) return setError('Tick the box to confirm the large change.')
    setReasonError(null)
    setError(null)
    setBusy(true)
    try {
      await onSubmit(trimmed, confirmed)
    } catch (e) {
      if (e instanceof HandledError) {
        setBusy(false)
        return
      }
      if (e instanceof ApiError && Array.isArray(e.details) && (e.details as { path?: string }[]).some((d) => d.path === 'confirmLargeChange')) {
        setNeedsConfirm(true)
        setError(e.message)
      } else setError(e instanceof ApiError ? e.message : 'That did not work. Try again.')
      setBusy(false)
    }
  }

  return (
    <Modal title={title} description={description} onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {children}
        <div>
          <label htmlFor="pc-reason" className="text-sm font-medium">
            Reason
          </label>
          <textarea
            id="pc-reason"
            rows={2}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonError ? true : undefined}
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-bad)]"
            placeholder="Diwali offer from 1 Nov"
          />
          {reasonError ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {reasonError}
            </p>
          ) : null}
        </div>
        {needsConfirm ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2.5 text-sm text-[var(--color-warn)]">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
            I understand this is a large price change and it’s intended.
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${tone === 'danger' ? 'bg-[var(--color-bad)] hover:opacity-90' : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]'}`}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
