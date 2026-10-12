import { Link } from 'react-router-dom'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'
import { formatRupees } from '../../../lib/money'
import type { FeeSummary } from '../api/paymentConfig.api'
import { feeLabel, PERIOD_SUFFIX } from '../feeRules'

const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })

type Props = { fee: FeeSummary; canPublish: boolean; busy: boolean; onToggle: (fee: FeeSummary, next: boolean) => void }

export function FeeCard({ fee, canPublish, busy, onToggle }: Props) {
  const { active, scheduled, draft } = fee
  const name = active?.name ?? feeLabel(fee.feeCode)
  return (
    <li className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/payments/config/${fee.feeCode}`} className="block truncate text-[15px] font-semibold hover:text-[var(--color-accent)]">
            {name}
          </Link>
          <code className="text-[11px] text-[var(--color-fg-muted)]">{fee.feeCode}</code>
        </div>
        {active ? <StatusSwitch checked={active.isEnabled} label={`${name} on or off`} disabled={!canPublish || busy} onChange={(next) => onToggle(fee, next)} /> : null}
      </div>

      {active ? (
        <p className="mt-4 text-2xl font-semibold tracking-tight">
          {formatRupees(active.amountPaise)}
          <span className="text-sm font-normal text-[var(--color-fg-muted)]">{PERIOD_SUFFIX[active.billingPeriod]}</span>
        </p>
      ) : (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">No live version.</p>
      )}
      {active && !active.isEnabled ? (
        <p className="mt-1">
          <StatusBadge tone="warn">Switched off</StatusBadge>
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {scheduled ? (
          <StatusBadge tone="info">
            Changes on {shortDate.format(new Date(scheduled.effectiveFrom))} → {formatRupees(scheduled.amountPaise)}
          </StatusBadge>
        ) : null}
        {draft ? <StatusBadge tone="neutral">Draft in progress</StatusBadge> : null}
      </div>

      <dl className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-fg-muted)]">
        <div>
          <dt className="sr-only">Last 30 days</dt>
          <dd>
            {fee.usage30d.captured.toLocaleString('en-IN')} sales · {formatRupees(fee.usage30d.revenuePaise)} in 30 days
          </dd>
        </div>
        <Link to={`/payments/config/${fee.feeCode}`} className="font-medium text-[var(--color-accent)] hover:underline" aria-label={`Open ${name}`}>
          Open
        </Link>
      </dl>
    </li>
  )
}
