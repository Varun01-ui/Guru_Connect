import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '../../../../components/shared/ConfirmDialog'
import { Pagination } from '../../../../components/shared/Pagination'
import { ApiError } from '../../../../lib/api'
import { useDebouncedValue } from '../../../../lib/useDebouncedValue'
import { usePermissions } from '../../../auth/usePermissions'
import { deleteBanner, fetchBanners, fetchCityOptions, pauseBanner, PLACEMENTS, previewBanners, publishBanner, reorderBanners, resumeBanner } from '../api/banners.api'
import type { Banner, BannerStatus, Placement } from '../api/banners.api'
import { BannerCard } from '../components/BannerCard'
import { PhonePreview } from '../components/PhonePreview'

const STATUSES: BannerStatus[] = ['draft', 'scheduled', 'active', 'paused', 'expired']
const field = 'h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]'

export function BannersPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canManage = can('banners.manage')
  const [placement, setPlacement] = useState<Placement | 'all'>('all')
  const [status, setStatus] = useState<BannerStatus | ''>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [toDelete, setToDelete] = useState<Banner | null>(null)
  const [audience, setAudience] = useState('parents')
  const [cityId, setCityId] = useState('')
  const q = useDebouncedValue(search.trim(), 300)

  // One placement with no other filter is the whole ordered stack, which is what the move buttons rearrange.
  const orderable = placement !== 'all' && status === '' && q === ''
  const params = { page: orderable ? 1 : page, pageSize: orderable ? 100 : pageSize, ...(placement !== 'all' ? { placement } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) }
  const list = useQuery({ queryKey: ['banners', 'list', params], queryFn: () => fetchBanners(params) })
  const cities = useQuery({ queryKey: ['banners', 'cities'], queryFn: fetchCityOptions, staleTime: 10 * 60_000 })
  const preview = useQuery({ queryKey: ['banners', 'preview', audience, cityId], queryFn: () => previewBanners(audience, cityId || undefined) })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['banners'] })
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'publish' | 'pause' | 'resume' | 'delete' }) => {
      if (action === 'publish') await publishBanner(id)
      else if (action === 'pause') await pauseBanner(id)
      else if (action === 'resume') await resumeBanner(id)
      else await deleteBanner(id)
    },
    onSettled: refresh,
  })
  const reorder = useMutation({ mutationFn: ({ target, ids }: { target: Placement; ids: string[] }) => reorderBanners(target, ids), onSettled: refresh })

  const banners = list.data?.data ?? []
  const busy = act.isPending || reorder.isPending
  const error = act.error ?? reorder.error

  function move(index: number, direction: -1 | 1) {
    if (placement === 'all') return
    const ids = banners.map((b) => b.id)
    const other = index + direction
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    reorder.mutate({ target: placement, ids })
  }

  const previewPlacement: Placement = placement === 'all' ? 'home_top' : placement
  const previewItems = preview.data?.placements[previewPlacement] ?? []

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Banners</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Promotions shown in the mobile app. They go live and end on their own.</p>
        </div>
        {canManage ? (
          <Link to="/cms/banners/new" className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)]">
            New banner
          </Link>
        ) : null}
      </div>

      <div role="tablist" aria-label="Placements" className="mt-6 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {[{ value: 'all', label: 'All' }, ...PLACEMENTS].map((p) => {
          const selected = placement === p.value
          return (
            <button
              key={p.value}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => {
                setPlacement(p.value as Placement | 'all')
                setPage(1)
              }}
              className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${selected ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="bn-search">
          Search banners
        </label>
        <input id="bn-search" type="search" placeholder="Search by title" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className={`${field} w-56`} />
        <label className="sr-only" htmlFor="bn-status">
          Status
        </label>
        <select id="bn-status" value={status} onChange={(e) => { setStatus(e.target.value as BannerStatus | ''); setPage(1) }} className={field}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        {orderable && canManage ? <span className="text-xs text-[var(--color-fg-muted)]">Use ↑ ↓ to set the order. The top banner shows first.</span> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-[var(--color-bad-soft)] px-4 py-3 text-sm text-[var(--color-bad)]">
          {error instanceof ApiError ? error.message : 'That did not work. Try again.'}
        </p>
      ) : null}

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          {list.isPending ? (
            <p className="text-sm text-[var(--color-fg-muted)]">Loading banners…</p>
          ) : list.isError ? (
            <div role="alert" className="text-sm">
              <p className="text-[var(--color-bad)]">{list.error instanceof ApiError ? list.error.message : 'Could not load the banners.'}</p>
              <button type="button" className="mt-3 font-medium text-[var(--color-accent)] hover:underline" onClick={() => list.refetch()}>
                Try again
              </button>
            </div>
          ) : banners.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-sm text-[var(--color-fg-muted)]">No banners match.</p>
          ) : (
            <>
              <ul className="space-y-4">
                {banners.map((banner, index) => (
                  <BannerCard
                    key={banner.id}
                    banner={banner}
                    canManage={canManage}
                    busy={busy}
                    isFirst={index === 0}
                    isLast={index === banners.length - 1}
                    onMove={orderable ? (direction) => move(index, direction) : undefined}
                    onAction={(action) => (action === 'delete' ? setToDelete(banner) : act.mutate({ id: banner.id, action }))}
                  />
                ))}
              </ul>
              {!orderable && list.data ? (
                <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <Pagination page={list.data.meta.page} pageSize={list.data.meta.pageSize} total={list.data.meta.total} totalPages={list.data.meta.totalPages} onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(1) }} />
                </div>
              ) : null}
            </>
          )}
        </div>

        <aside aria-label="Audience preview" className="space-y-3">
          <h2 className="text-sm font-semibold">What users see</h2>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="text-[var(--color-fg-muted)]">Audience</span>
              <select aria-label="Preview audience" value={audience} onChange={(e) => setAudience(e.target.value)} className={`${field} mt-1 w-full`}>
                <option value="parents">Parents</option>
                <option value="students">Students</option>
                <option value="teachers">Teachers</option>
                <option value="institutes">Institutes</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="text-[var(--color-fg-muted)]">City</span>
              <select aria-label="Preview city" value={cityId} onChange={(e) => setCityId(e.target.value)} className={`${field} mt-1 w-full`}>
                <option value="">Any city</option>
                {(cities.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {preview.isError ? (
            <p role="alert" className="text-xs text-[var(--color-bad)]">
              Could not load the preview.
            </p>
          ) : (
            <PhonePreview items={previewItems.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl }))} caption={PLACEMENTS.find((p) => p.value === previewPlacement)?.label} emptyText="No live banner for this audience here." />
          )}
        </aside>
      </div>

      {toDelete ? (
        <ConfirmDialog
          title="Delete this banner?"
          message={`“${toDelete.title}” stops showing and disappears from the list.`}
          confirmLabel="Delete banner"
          tone="danger"
          busy={act.isPending}
          onCancel={() => setToDelete(null)}
          onConfirm={() => act.mutate({ id: toDelete.id, action: 'delete' }, { onSettled: () => setToDelete(null) })}
        />
      ) : null}
    </div>
  )
}
