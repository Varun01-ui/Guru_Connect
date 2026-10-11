import type { ReactNode } from 'react'

export type SortState<K extends string = string> = { key: K; dir: 'asc' | 'desc' }

export type DataTableColumn<Row, K extends string = string> = {
  id: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** When set, the header becomes a sort button that reports this key. */
  sortKey?: K
  align?: 'right'
}

type Props<Row, K extends string> = {
  columns: DataTableColumn<Row, K>[]
  rows: Row[]
  rowKey: (row: Row) => string
  label: string
  isLoading?: boolean
  loadingText?: string
  /** Set while a refetch is running with the old rows still on screen. */
  isRefreshing?: boolean
  errorMessage?: string | null
  onRetry?: () => void
  emptyText: string
  sort?: SortState<K> | null
  onSort?: (key: K) => void
  rowClassName?: (row: Row) => string
}

// Shared list table: owns the loading / error / empty states so every admin list looks and behaves the same.
export function DataTable<Row, K extends string = string>({
  columns,
  rows,
  rowKey,
  label,
  isLoading,
  loadingText = 'Loading…',
  isRefreshing,
  errorMessage,
  onRetry,
  emptyText,
  sort,
  onSort,
  rowClassName,
}: Props<Row, K>) {
  if (isLoading) {
    return <p className="px-4 py-8 text-sm text-[var(--color-fg-muted)]">{loadingText}</p>
  }

  if (errorMessage) {
    return (
      <div role="alert" className="px-4 py-8 text-sm">
        <p className="text-[var(--color-bad)]">{errorMessage}</p>
        {onRetry ? (
          <button className="mt-3 font-medium text-[var(--color-accent)] hover:underline" type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    )
  }

  if (rows.length === 0) {
    return <p className="px-4 py-8 text-sm text-[var(--color-fg-muted)]">{emptyText}</p>
  }

  return (
    <div className="overflow-x-auto">
      <table aria-label={label} aria-busy={isRefreshing ? true : undefined} className={`w-full text-left text-sm transition-opacity ${isRefreshing ? 'opacity-60' : ''}`}>
        <thead className="bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          <tr>
            {columns.map((column) => {
              const active = column.sortKey !== undefined && sort?.key === column.sortKey
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : column.sortKey ? 'none' : undefined}
                  className={`px-4 py-2.5 font-semibold ${column.align === 'right' ? 'text-right' : ''}`}
                >
                  {column.sortKey && onSort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-[var(--color-fg)]"
                      onClick={() => onSort(column.sortKey!)}
                    >
                      {column.header}
                      <span aria-hidden="true">{active ? (sort!.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={`border-t border-[var(--color-border)] ${rowClassName?.(row) ?? ''}`}>
              {columns.map((column) => (
                <td key={column.id} className={`px-4 py-3 align-middle ${column.align === 'right' ? 'text-right' : ''}`}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
