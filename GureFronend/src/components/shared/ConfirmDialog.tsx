import { useEffect, useId } from 'react'

type Props = {
  title: string
  message: string
  confirmLabel: string
  /** 'danger' paints the confirm button red (deletes); the default is the accent colour. */
  tone?: 'default' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Small "are you sure?" dialog for actions that need a sentence of context first.
export function ConfirmDialog({ title, message, confirmLabel, tone = 'default', busy = false, onConfirm, onCancel }: Props) {
  const titleId = useId()
  const messageId = useId()

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="w-full max-w-sm animate-[fade-in-up_0.3s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
              tone === 'danger' ? 'bg-[var(--color-bad)] hover:opacity-90' : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
