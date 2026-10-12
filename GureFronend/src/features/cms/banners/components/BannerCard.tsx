import { Link } from 'react-router-dom'
import { StatusBadge } from '../../../../components/shared/StatusBadge'
import { formatDateTime } from '../../../../lib/format'
import { AUDIENCES, PLACEMENTS } from '../api/banners.api'
import type { Banner, BannerStatus } from '../api/banners.api'

const TONE: Record<BannerStatus, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { draft: 'neutral', scheduled: 'info', active: 'good', paused: 'warn', expired: 'bad' }
const label = <T extends readonly { value: string; label: string }[]>(list: T, value: string) => list.find((i) => i.value === value)?.label ?? value

type Props = {
  banner: Banner
  canManage: boolean
  busy: boolean
  /** Move buttons only appear when the list is one placement in priority order. */
  onMove?: (direction: -1 | 1) => void
  isFirst?: boolean
  isLast?: boolean
  onAction: (action: 'publish' | 'pause' | 'resume' | 'delete') => void
}

export function BannerCard({ banner, canManage, busy, onMove, isFirst, isLast, onAction }: Props) {
  const button = 'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50'
  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:flex-row">
      {banner.image.url ? (
        <img src={banner.image.url} alt="" className="aspect-[2.25/1] w-full flex-none rounded-xl object-cover sm:w-56" />
      ) : (
        <div className="aspect-[2.25/1] w-full flex-none rounded-xl bg-[var(--color-surface-2)] sm:w-56" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/cms/banners/${banner.id}`} className="truncate text-[15px] font-semibold hover:text-[var(--color-accent)]">
            {banner.title}
          </Link>
          <StatusBadge tone={TONE[banner.status]}>{banner.status}</StatusBadge>
        </div>
        {banner.subtitle ? <p className="mt-0.5 truncate text-sm text-[var(--color-fg-muted)]">{banner.subtitle}</p> : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[var(--color-fg-muted)]">Where</dt>
            <dd className="font-medium">{label(PLACEMENTS, banner.placement)}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-muted)]">Who</dt>
            <dd className="font-medium">
              {label(AUDIENCES, banner.audience)} · {banner.cities.length === 0 ? 'all cities' : banner.cities.map((c) => c.name).join(', ')}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-muted)]">Runs</dt>
            <dd className="font-medium">
              {formatDateTime(banner.startsAt)} → {banner.endsAt ? formatDateTime(banner.endsAt) : 'until paused'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-muted)]">Click-through</dt>
            <dd className="font-medium">
              {banner.ctrPct === null ? '—' : `${banner.ctrPct}%`} <span className="font-normal text-[var(--color-fg-muted)]">({banner.clicks.toLocaleString('en-IN')} / {banner.impressions.toLocaleString('en-IN')})</span>
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canManage ? (
            <>
              {banner.status === 'draft' ? (
                <button type="button" className={`${button} !border-[var(--color-accent)] !text-[var(--color-accent)]`} disabled={busy} onClick={() => onAction('publish')}>
                  Publish
                </button>
              ) : null}
              {banner.status === 'active' ? (
                <button type="button" className={button} disabled={busy} onClick={() => onAction('pause')}>
                  Pause
                </button>
              ) : null}
              {banner.status === 'paused' ? (
                <button type="button" className={button} disabled={busy} onClick={() => onAction('resume')}>
                  Resume
                </button>
              ) : null}
              {banner.status !== 'active' ? (
                <button type="button" className={`${button} !text-[var(--color-bad)]`} disabled={busy} onClick={() => onAction('delete')}>
                  Delete
                </button>
              ) : null}
            </>
          ) : null}
          <Link to={`/cms/banners/${banner.id}`} className={button}>
            {canManage && banner.status !== 'expired' ? 'Edit' : 'View'}
          </Link>
          {canManage && onMove ? (
            <span className="ml-auto flex gap-1" role="group" aria-label={`Order of ${banner.title}`}>
              <button type="button" className={button} disabled={busy || isFirst} onClick={() => onMove(-1)} aria-label={`Move ${banner.title} up`}>
                ↑
              </button>
              <button type="button" className={button} disabled={busy || isLast} onClick={() => onMove(1)} aria-label={`Move ${banner.title} down`}>
                ↓
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </li>
  )
}
