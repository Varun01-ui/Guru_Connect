const PAGE_SIZES = [10, 20, 50, 100] as const

type Props = {
  page: number
  pageSize: number
  total: number
  totalPages: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}

export function Pagination({ page, pageSize, total, totalPages, onPage, onPageSize }: Props) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const button =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] font-medium transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--color-border)]'

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3 text-[13px] text-[var(--color-fg-muted)]">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          Rows
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[var(--color-fg)]"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={button} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button type="button" className={button} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  )
}
