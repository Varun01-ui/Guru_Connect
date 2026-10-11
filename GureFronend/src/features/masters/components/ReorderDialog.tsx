import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import type { FieldValues } from 'react-hook-form'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { ApiError } from '../../../lib/api'
import { listMasters, reorderMasters } from '../api/masters.api'
import type { MasterConfig, MasterRow } from '../types'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  onClose: () => void
  onSaved: () => void
}

const MAX_ROWS = 100
const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-sm transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border)]'

// Reorder as a list you can drag, or move with the arrow buttons (keyboard and touch friendly). Nothing is saved until
// "Save order"; the API rewrites the whole sequence in one transaction.
export function ReorderDialog<Row extends MasterRow, Form extends FieldValues>({ config, onClose, onSaved }: Props<Row, Form>) {
  const titleId = useId()
  const list = useQuery({
    queryKey: [config.key, 'reorder'],
    queryFn: () => listMasters<Row>(config.apiPath, { page: 1, pageSize: MAX_ROWS, sort: { key: config.reorder!.sort, dir: 'asc' } }),
    gcTime: 0,
  })
  // null until the admin moves something; until then the order on screen is whatever the API returned.
  const [edited, setEdited] = useState<Row[] | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  const rows = edited ?? list.data?.data ?? []
  const tooMany = (list.data?.meta.total ?? 0) > MAX_ROWS
  const changed = list.data !== undefined && rows.some((row, i) => row.id !== list.data!.data[i]?.id)

  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return
    const next = [...rows]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    setEdited(next)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await reorderMasters(config.apiPath, rows.map((r) => r.id))
      onSaved()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Could not save the order of the ${config.plural}.`)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Reorder {config.plural}
        </h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Drag a row, or use the arrows. The first one comes first in the app.</p>
        {config.reorder?.warning ? (
          <p className="mt-3 rounded-lg bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">{config.reorder.warning}</p>
        ) : null}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? (
            <p className="py-6 text-sm text-[var(--color-fg-muted)]">Loading {config.plural}…</p>
          ) : list.isError ? (
            <p role="alert" className="py-6 text-sm text-[var(--color-bad)]">
              {list.error instanceof ApiError ? list.error.message : `Could not load the ${config.plural}.`}
            </p>
          ) : tooMany ? (
            <p role="alert" className="py-6 text-sm text-[var(--color-bad)]">
              There are more than {MAX_ROWS} {config.plural}, which is too many to reorder here.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {rows.map((row, index) => (
                <li
                  key={row.id}
                  draggable
                  onDragStart={() => setDragging(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) move(dragging, index)
                    setDragging(null)
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={`flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 ${dragging === index ? 'opacity-50' : ''}`}
                >
                  <span aria-hidden="true" className="cursor-grab select-none text-[var(--color-fg-muted)]">
                    ⋮⋮
                  </span>
                  <span className="w-6 text-right text-xs text-[var(--color-fg-muted)]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                  {row.isActive ? null : <StatusBadge>Inactive</StatusBadge>}
                  <button type="button" className={iconButton} aria-label={`Move ${row.name} up`} disabled={index === 0 || saving} onClick={() => move(index, index - 1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Move ${row.name} down`}
                    disabled={index === rows.length - 1 || saving}
                    onClick={() => move(index, index + 1)}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!changed || saving || tooMany}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save order'}
          </button>
        </div>
      </div>
    </div>
  )
}
