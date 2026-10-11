import { useEffect, useId } from 'react'
import type { ReactNode } from 'react'

type Props = {
  title: string
  description?: string
  onClose: () => void
  /** While true the dialog can't be dismissed (a save is running). */
  busy?: boolean
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }

// Centered dialog shell: overlay, focus-friendly heading, Escape and backdrop dismissal.
export function Modal({ title, description, onClose, busy = false, size = 'md', children }: Props) {
  const titleId = useId()

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[90vh] w-full ${SIZES[size]} animate-[fade-in-up_0.3s_ease-out] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]`}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{description}</p> : null}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
