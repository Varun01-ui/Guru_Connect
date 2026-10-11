import { useId, useState } from 'react'
import { ApiError } from '../../../lib/api'
import { deleteMaster, setMasterActive } from '../api/masters.api'
import type { MasterConfig, MasterRow } from '../types'
import type { FieldValues } from 'react-hook-form'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  row: Row
  onClose: () => void
  onDone: (outcome: 'deleted' | 'deactivated') => void
}

// Delete is blocked while live records use the row (CONFLICT_IN_USE). The dialog then shows the counts and offers
// "Deactivate instead", which hides the row from the app without touching the data (FR-7.5).
export function DeleteOrDeactivateDialog<Row extends MasterRow, Form extends FieldValues>({ config, row, onClose, onDone }: Props<Row, Form>) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [references, setReferences] = useState<Record<string, number> | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await deleteMaster(config.apiPath, row.id)
      onDone('deleted')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_IN_USE') {
        setReferences((e.details as { references?: Record<string, number> } | undefined)?.references ?? {})
      } else {
        setError(e instanceof ApiError ? e.message : `Could not delete this ${config.singular}.`)
      }
      setBusy(false)
    }
  }

  async function deactivate() {
    setBusy(true)
    setError(null)
    try {
      await setMasterActive(config.apiPath, row.id, false)
      onDone('deactivated')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Could not deactivate this ${config.singular}.`)
      setBusy(false)
    }
  }

  const inUse = references !== null
  const usage = Object.entries(references ?? {})
    .map(([table, count]) => `${count} ${config.referenceNames[table] ?? table.replace(/[_.]/g, ' ')}`)
    .join(', ')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm animate-[fade-in-up_0.3s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {inUse ? `${row.name} is in use` : `Delete ${row.name}?`}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {inUse
            ? `This ${config.singular} is used by live records${usage ? ` (${usage})` : ''}, so it can't be deleted. Deactivate it instead to hide it from the app without losing any data.`
            : `It disappears from lists and the app. A Super Admin can restore it later.`}
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          {inUse ? (
            row.isActive ? (
              <button
                type="button"
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
                disabled={busy}
                autoFocus
                onClick={deactivate}
              >
                {busy ? 'Deactivating…' : 'Deactivate instead'}
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className="rounded-lg bg-[var(--color-bad)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              disabled={busy}
              autoFocus
              onClick={remove}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
