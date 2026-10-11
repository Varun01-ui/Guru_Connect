import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { FieldValues } from 'react-hook-form'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { DataTable } from '../../../components/shared/DataTable'
import type { DataTableColumn, SortState } from '../../../components/shared/DataTable'
import { Pagination } from '../../../components/shared/Pagination'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'
import { ApiError } from '../../../lib/api'
import type { PageMeta } from '../../../lib/api'
import { useDebouncedValue } from '../../../lib/useDebouncedValue'
import { usePermissions } from '../../auth/usePermissions'
import { listMasters, restoreMaster, setMasterActive } from '../api/masters.api'
import type { ListParams } from '../api/masters.api'
import { DeleteOrDeactivateDialog } from '../components/DeleteOrDeactivateDialog'
import { ImportCsvDialog } from '../components/ImportCsvDialog'
import { MergeDialog } from '../components/MergeDialog'
import { MasterFormDrawer } from '../components/MasterFormDrawer'
import { ReorderDialog } from '../components/ReorderDialog'
import { UsageBadge } from '../components/UsageBadge'
import { useOptions } from '../hooks/useOptions'
import type { MasterConfig, MasterFilter, MasterRow, SortKey } from '../types'

type ListResult<Row> = { data: Row[]; meta: PageMeta }
type StatusFilter = 'all' | 'active' | 'inactive'

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback)

const primaryButton =
  'rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)]'
const secondaryButton =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2 text-[13px] font-semibold transition-colors hover:border-[var(--color-accent)]'
const linkButton = 'text-[13px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50'

const selectClass = 'h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)]'

function FilterSelect({ filter, value, onChange }: { filter: MasterFilter; value: string; onChange: (value: string) => void }) {
  const remote = useOptions(filter.optionsFrom, filter.optionsValueKey)
  const options = [...(filter.options ?? []), ...(remote.data ?? [])]
  return (
    <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
      {filter.label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">{filter.allLabel ?? 'All'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

// One generic list screen for every master-data module (spec section 14): the config says what the columns,
// form and API paths are, this page owns search, filters, sorting, paging, the active switch and row actions.
export function MasterListPage<Row extends MasterRow, Form extends FieldValues>({ config }: { config: MasterConfig<Row, Form> }) {
  const queryClient = useQueryClient()
  const { can, isSuperAdmin } = usePermissions()
  const canManage = can(config.managePermission)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [sort, setSort] = useState<SortState<SortKey> | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [reordering, setReordering] = useState(false)
  const [merging, setMerging] = useState<Row | null>(null)
  const [confirmingOff, setConfirmingOff] = useState<{ row: Row; message: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const q = useDebouncedValue(search.trim(), 300)
  const params: ListParams = {
    page,
    pageSize,
    q: q || undefined,
    active: status === 'all' ? undefined : status === 'active',
    sort: sort ?? undefined,
    includeDeleted: includeDeleted || undefined,
    extra: Object.fromEntries(Object.entries(filterValues).filter(([, v]) => v !== '')),
  }
  const listKey = [config.key, 'list'] as const

  const list = useQuery({
    queryKey: [...listKey, params],
    queryFn: () => listMasters<Row>(config.apiPath, params),
    placeholderData: keepPreviousData,
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: [config.key] })

  // Optimistic: flip the switch at once, roll every cached page back if the API refuses.
  const toggle = useMutation({
    mutationFn: ({ row, next }: { row: Row; next: boolean }) => setMasterActive<Row>(config.apiPath, row.id, next),
    onMutate: async ({ row, next }) => {
      setActionError(null)
      await queryClient.cancelQueries({ queryKey: listKey })
      const snapshots = queryClient.getQueriesData<ListResult<Row>>({ queryKey: listKey })
      queryClient.setQueriesData<ListResult<Row>>({ queryKey: listKey }, (old) =>
        old ? { ...old, data: old.data.map((r) => (r.id === row.id ? { ...r, isActive: next } : r)) } : old,
      )
      return { snapshots }
    },
    onError: (error, _vars, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
      setActionError(errorText(error, `Could not update this ${config.singular}.`))
    },
    onSettled: refresh,
  })

  const restore = useMutation({
    mutationFn: (row: Row) => restoreMaster<Row>(config.apiPath, row.id),
    onMutate: () => setActionError(null),
    onSuccess: (row) => {
      setNotice(`${capitalise(config.singular)} ${row.name} restored.`)
      return refresh()
    },
    onError: (error) => setActionError(errorText(error, `Could not restore this ${config.singular}.`)),
  })

  function changeFilter(apply: () => void) {
    apply()
    setPage(1)
  }

  function onSort(key: SortKey) {
    changeFilter(() => setSort((current) => (current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })))
  }

  const columns: DataTableColumn<Row, SortKey>[] = [
    ...config.columns,
    {
      id: 'usage',
      header: 'Used by',
      cell: (row) => {
        const usage = config.usage(row)
        return <UsageBadge count={usage.count} label={usage.label} />
      },
    },
    {
      id: 'active',
      header: 'Active',
      cell: (row) =>
        row.deletedAt ? (
          <StatusBadge tone="bad">Deleted</StatusBadge>
        ) : (
          <StatusSwitch
            checked={row.isActive}
            label={`${row.name} active`}
            disabled={!canManage || config.rowRules?.canToggle?.(row) === false}
            onChange={(next) => {
              const message = next ? null : (config.confirmDeactivate?.(row) ?? null)
              if (message) setConfirmingOff({ row, message })
              else toggle.mutate({ row, next })
            }}
          />
        ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (row) => {
        if (row.deletedAt) {
          return isSuperAdmin ? (
            <button type="button" className={linkButton} disabled={restore.isPending} onClick={() => restore.mutate(row)}>
              Restore
            </button>
          ) : null
        }
        if (!canManage) return null
        return (
          <span className="inline-flex gap-4">
            <button type="button" className={linkButton} aria-label={`Edit ${row.name}`} onClick={() => {
                setNotice(null)
                setEditing(row)
              }}>
              Edit
            </button>
            {config.merge ? (
              <button
                type="button"
                className={linkButton}
                aria-label={`Merge ${row.name}`}
                onClick={() => {
                  setNotice(null)
                  setMerging(row)
                }}
              >
                Merge
              </button>
            ) : null}
            {config.rowRules?.canDelete?.(row) === false ? null : (
              <button
                type="button"
                className="text-[13px] font-medium text-[var(--color-bad)] hover:underline"
                aria-label={`Delete ${row.name}`}
                onClick={() => {
                  setNotice(null)
                  setDeleting(row)
                }}
              >
                Delete
              </button>
            )}
          </span>
        )
      },
    },
  ]

  const filtered = Boolean(q) || status !== 'all' || includeDeleted || Object.values(filterValues).some(Boolean)
  const emptyText = filtered
    ? `No ${config.plural} match your filters.`
    : `No ${config.plural} yet.${canManage ? ` Add the first ${config.singular}.` : ''}`

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{config.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{config.description}</p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {config.reorder ? (
              <button type="button" className={secondaryButton} onClick={() => setReordering(true)}>
                Reorder
              </button>
            ) : null}
            {config.importCsv ? (
              <button type="button" className={secondaryButton} onClick={() => setImporting(true)}>
                Import CSV
              </button>
            ) : null}
            <button
              type="button"
              className={primaryButton}
              onClick={() => {
                setNotice(null)
                setEditing('new')
              }}
            >
              Add {config.singular}
            </button>
          </div>
        ) : null}
      </div>

      <section className="mt-6 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <input
            type="search"
            value={search}
            onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            placeholder={config.searchPlaceholder}
            aria-label={`Search ${config.plural}`}
            className="h-10 min-w-[16rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            Status
            <select
              value={status}
              onChange={(e) => changeFilter(() => setStatus(e.target.value as StatusFilter))}
              className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)]"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          {(config.filters ?? []).map((filter) => (
            <FilterSelect
              key={filter.param}
              filter={filter}
              value={filterValues[filter.param] ?? ''}
              onChange={(value) => changeFilter(() => setFilterValues((current) => ({ ...current, [filter.param]: value })))}
            />
          ))}
          {isSuperAdmin ? (
            <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
              <input type="checkbox" checked={includeDeleted} onChange={(e) => changeFilter(() => setIncludeDeleted(e.target.checked))} />
              Show deleted
            </label>
          ) : null}
        </div>

        {notice ? (
          <p role="status" className="border-t border-[var(--color-border)] bg-[var(--color-good-soft)] px-4 py-2.5 text-sm text-[var(--color-good)]">
            {notice}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="border-t border-[var(--color-border)] bg-[var(--color-bad-soft)] px-4 py-2.5 text-sm text-[var(--color-bad)]">
            {actionError}
          </p>
        ) : null}

        <div className="border-t border-[var(--color-border)]">
          <DataTable
            label={config.title}
            columns={columns}
            rows={list.data?.data ?? []}
            rowKey={(row) => row.id}
            isLoading={list.isPending}
            loadingText={`Loading ${config.plural}…`}
            isRefreshing={list.isPlaceholderData}
            errorMessage={list.isError && !list.data ? errorText(list.error, `Could not load ${config.plural}.`) : null}
            onRetry={() => list.refetch()}
            emptyText={emptyText}
            sort={sort}
            onSort={onSort}
            rowClassName={(row) => (row.deletedAt ? 'opacity-60' : '')}
          />
        </div>

        {list.data && list.data.meta.total > 0 ? (
          <Pagination
            page={list.data.meta.page}
            pageSize={list.data.meta.pageSize}
            total={list.data.meta.total}
            totalPages={list.data.meta.totalPages}
            onPage={setPage}
            onPageSize={(size) => changeFilter(() => setPageSize(size))}
          />
        ) : null}
      </section>

      {editing ? (
        <MasterFormDrawer
          config={config}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(row, mode) => {
            setEditing(null)
            setNotice(`${capitalise(config.singular)} ${row.name} ${mode === 'created' ? 'added' : 'saved'}.`)
            refresh()
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteOrDeactivateDialog
          config={config}
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={(outcome) => {
            setNotice(`${capitalise(config.singular)} ${deleting.name} ${outcome}.`)
            setDeleting(null)
            refresh()
          }}
        />
      ) : null}
      {merging ? (
        <MergeDialog
          config={config}
          row={merging}
          onClose={() => setMerging(null)}
          onMerged={(into, moved) => {
            setNotice(`Merged ${merging.name} into ${into}. ${moved === 0 ? 'Nothing pointed at it.' : `${moved} ${moved === 1 ? 'record' : 'records'} moved.`}`)
            setMerging(null)
            refresh()
          }}
        />
      ) : null}

      {confirmingOff ? (
        <ConfirmDialog
          title={`Deactivate ${confirmingOff.row.name}?`}
          message={confirmingOff.message}
          confirmLabel="Deactivate"
          onCancel={() => setConfirmingOff(null)}
          onConfirm={() => {
            toggle.mutate({ row: confirmingOff.row, next: false })
            setConfirmingOff(null)
          }}
        />
      ) : null}

      {reordering ? (
        <ReorderDialog
          config={config}
          onClose={() => setReordering(false)}
          onSaved={() => {
            setReordering(false)
            setNotice(`Order of the ${config.plural} saved.`)
            refresh()
          }}
        />
      ) : null}

      {importing ? (
        <ImportCsvDialog
          config={config}
          onClose={() => setImporting(false)}
          onImported={(result) => {
            setImporting(false)
            setNotice(`Imported ${result.created.length} ${config.plural}${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ''}.`)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
