import { useInfiniteQuery } from '@tanstack/react-query'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { formatRupees } from '../../../lib/money'
import { fetchHistory } from '../api/paymentConfig.api'
import type { HistoryEntry } from '../api/paymentConfig.api'
import { feeLabel } from '../feeRules'

const ACTION: Record<string, string> = {
  published: 'Published',
  scheduled: 'Scheduled',
  activated: 'Went live',
  superseded: 'Replaced',
  cancelled: 'Schedule cancelled',
  enabled: 'Switched on',
  disabled: 'Switched off',
  created: 'Draft created',
  updated: 'Draft edited',
}

function summary(h: HistoryEntry): string | null {
  const next = h.newValues as { amountPaise?: number } | null
  const prev = h.oldValues as { amountPaise?: number } | null
  if (typeof next?.amountPaise !== 'number' || !['published', 'scheduled', 'enabled', 'disabled'].includes(h.action)) return null
  return typeof prev?.amountPaise === 'number' && prev.amountPaise !== next.amountPaise ? `${formatRupees(prev.amountPaise)} → ${formatRupees(next.amountPaise)}` : formatRupees(next.amountPaise)
}

// Change history across fees (or one fee), newest first, 50 at a time.
export function ConfigHistoryTimeline({ feeCode }: { feeCode?: string }) {
  const query = useInfiniteQuery({
    queryKey: ['payment-config', 'history', feeCode ?? 'all'],
    queryFn: ({ pageParam }) => fetchHistory({ cursor: pageParam, feeCode }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

  if (query.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading history…</p>
  if (query.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{query.error instanceof ApiError ? query.error.message : 'Could not load the history.'}</p>
        <button type="button" className="mt-2 font-medium text-[var(--color-accent)] hover:underline" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  const entries = query.data.pages.flatMap((p) => p.data)
  if (entries.length === 0) return <p className="text-sm text-[var(--color-fg-muted)]">No changes yet.</p>

  return (
    <div>
      <ol className="space-y-3 border-l border-[var(--color-border)] pl-4">
        {entries.map((h) => (
          <li key={h.id} className="relative text-sm">
            <span aria-hidden="true" className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">
                {ACTION[h.action] ?? h.action} · {feeLabel(h.feeCode)} v{h.version}
                {summary(h) ? <span className="ml-2 font-normal text-[var(--color-fg-muted)]">{summary(h)}</span> : null}
              </span>
              <time dateTime={h.createdAt} className="text-xs text-[var(--color-fg-muted)]">
                {formatDateTime(h.createdAt)}
              </time>
            </div>
            <div className="text-xs text-[var(--color-fg-muted)]">
              {h.changedBy?.name ?? 'System'}
              {h.reason ? ` · “${h.reason}”` : ''}
            </div>
          </li>
        ))}
      </ol>
      {query.hasNextPage ? (
        <button type="button" className="mt-4 rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-60" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  )
}
