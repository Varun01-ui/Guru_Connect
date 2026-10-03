import type { ReactNode } from 'react'
import { IconTrendingDown, IconTrendingUp } from '../icons'

type KpiCardProps = {
  label: string
  value: string
  icon: ReactNode
  delta?: number
  hint?: string
  tone?: 'accent' | 'good' | 'warn'
  style?: React.CSSProperties
}

const TONE_BG: Record<NonNullable<KpiCardProps['tone']>, string> = {
  accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  good: 'bg-[var(--color-good-soft)] text-[var(--color-good)]',
  warn: 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]',
}

export function KpiCard({ label, value, icon, delta, hint, tone = 'accent', style }: KpiCardProps) {
  return (
    <div
      className="animate-[fade-in-up_0.5s_ease-out_backwards] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]"
      style={style}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>{icon}</span>
        <span className="text-[12.5px] font-semibold text-[var(--color-fg-muted)]">{label}</span>
      </div>
      <div className="mt-2 font-[var(--font-display)] text-[26px] font-semibold leading-none tracking-tight">{value}</div>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
        {typeof delta === 'number' ? (
          <span className={`inline-flex items-center gap-0.5 font-bold ${delta >= 0 ? 'text-[var(--color-good)]' : 'text-[var(--color-bad)]'}`}>
            {delta >= 0 ? <IconTrendingUp className="h-3 w-3" /> : <IconTrendingDown className="h-3 w-3" />}
            {Math.abs(delta)}%
          </span>
        ) : null}
        {hint ? <span>{hint}</span> : null}
      </div>
    </div>
  )
}
