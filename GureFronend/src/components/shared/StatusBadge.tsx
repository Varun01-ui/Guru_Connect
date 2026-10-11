import type { ReactNode } from 'react'

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral'

const TONES: Record<Tone, string> = {
  good: 'bg-[var(--color-good-soft)] text-[var(--color-good)]',
  warn: 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
  bad: 'bg-[var(--color-bad-soft)] text-[var(--color-bad)]',
  info: 'bg-[var(--color-info-soft)] text-[var(--color-info)]',
  neutral: 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]',
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>
}
