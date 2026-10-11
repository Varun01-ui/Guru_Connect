import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { FieldValues } from 'react-hook-form'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'
import { fetchScopedOptions, mergeMaster } from '../api/masters.api'
import type { MasterConfig, MasterRow } from '../types'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  row: Row
  onClose: () => void
  /** `into` is the target's name; `moved` is how many records were repointed. */
  onMerged: (into: string, moved: number) => void
}

// Fold a duplicate into the row it should have been (FR-10.S2, FR-12.S1): everything that points at this row moves to the
// target and this row is removed.
export function MergeDialog<Row extends MasterRow, Form extends FieldValues>({ config, row, onClose, onMerged }: Props<Row, Form>) {
  const merge = config.merge!
  const scope = merge.scope?.(row) ?? {}
  const options = useQuery({ queryKey: ['masters', 'merge-options', config.apiPath, scope], queryFn: () => fetchScopedOptions(config.apiPath, scope), gcTime: 0 })
  const [targetId, setTargetId] = useState('')
  const [reason, setReason] = useState('')
  const [targetError, setTargetError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const choices = (options.data ?? []).filter((o) => o.value !== row.id)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!targetId) {
      setTargetError(`Pick the ${config.singular} to merge into.`)
      return
    }
    setTargetError(null)
    setSaving(true)
    try {
      const result = await mergeMaster(config.apiPath, row.id, merge.targetKey, targetId, reason.trim() || undefined)
      onMerged(choices.find((c) => c.value === targetId)?.label ?? 'the other one', Object.values(result.moved ?? {}).reduce((sum, n) => sum + n, 0))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details) && (e.details as { path?: string }[]).some((d) => d.path === merge.targetKey)) setTargetError(e.message)
      else setError(e instanceof ApiError ? e.message : `Could not merge this ${config.singular}. Try again.`)
      setSaving(false)
    }
  }

  return (
    <Modal title={`Merge ${row.name}`} description={merge.warning} onClose={onClose} busy={saving}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label htmlFor="merge-target" className="text-sm font-medium">
            Merge into
          </label>
          <select
            id="merge-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={options.isPending}
            aria-invalid={targetError ? true : undefined}
            className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]"
          >
            <option value="">{options.isPending ? 'Loading…' : 'Select…'}</option>
            {choices.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {options.isError ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {options.error instanceof ApiError ? options.error.message : `Could not load the ${config.plural}.`}
            </p>
          ) : null}
          {targetError ? (
            <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
              {targetError}
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="merge-reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-muted)]">(optional, goes to the audit log)</span>
          </label>
          <textarea
            id="merge-reason"
            rows={2}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-[var(--color-bad)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60" disabled={saving || options.isPending}>
            {saving ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
