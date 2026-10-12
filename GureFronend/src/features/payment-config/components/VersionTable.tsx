import { StatusBadge } from '../../../components/shared/StatusBadge'
import { formatDateTime } from '../../../lib/format'
import { formatRupees } from '../../../lib/money'
import type { Version, VersionStatus } from '../api/paymentConfig.api'

const TONE: Record<VersionStatus, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { active: 'good', scheduled: 'info', draft: 'neutral', superseded: 'neutral', cancelled: 'bad' }

type Props = {
  versions: Version[]
  canPublish: boolean
  onCancel: (version: Version) => void
  onRestore: (version: Version) => void
}

export function VersionTable({ versions, canPublish, onCancel, onRestore }: Props) {
  if (versions.length === 0) return <p className="px-4 py-6 text-sm text-[var(--color-fg-muted)]">No versions yet.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Every version of this fee</caption>
        <thead className="bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">Version</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Price</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Effective</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Published by</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Reason</th>
            <th scope="col" className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-t border-[var(--color-border)] align-top">
              <td className="px-4 py-3 font-medium">v{v.version}</td>
              <td className="px-4 py-3">
                <StatusBadge tone={TONE[v.status]}>{v.status}</StatusBadge>
                {!v.isEnabled ? <span className="ml-1.5 text-xs text-[var(--color-warn)]">off</span> : null}
              </td>
              <td className="px-4 py-3">{formatRupees(v.amountPaise)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-[13px]">
                {v.status === 'draft' ? '—' : formatDateTime(v.effectiveFrom)}
                {v.effectiveTo ? <div className="text-xs text-[var(--color-fg-muted)]">until {formatDateTime(v.effectiveTo)}</div> : null}
              </td>
              <td className="px-4 py-3">{v.publishedBy?.name ?? '—'}</td>
              <td className="max-w-56 px-4 py-3 text-[13px] text-[var(--color-fg-muted)]">{v.changeReason ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                {canPublish && v.status === 'scheduled' ? (
                  <button type="button" className="text-[13px] font-medium text-[var(--color-bad)] hover:underline" onClick={() => onCancel(v)} aria-label={`Cancel version ${v.version}`}>
                    Cancel
                  </button>
                ) : null}
                {canPublish && (v.status === 'superseded' || v.status === 'cancelled') ? (
                  <button type="button" className="text-[13px] font-medium text-[var(--color-accent)] hover:underline" onClick={() => onRestore(v)} aria-label={`Restore version ${v.version}`}>
                    Restore
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
