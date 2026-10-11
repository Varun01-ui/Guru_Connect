import { useEffect, useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { FieldValues } from 'react-hook-form'
import { ApiError } from '../../../lib/api'
import { importMasters } from '../api/masters.api'
import type { ImportResult } from '../api/masters.api'
import type { MasterConfig, MasterRow } from '../types'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  onClose: () => void
  onImported: (result: ImportResult) => void
}

type RowProblem = { row?: number; message: string }

const button = 'rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60'

// Upload (or paste) a CSV, check it without saving anything, then apply it. The API validates the whole file and applies
// it in one transaction, so a file with any bad row changes nothing.
export function ImportCsvDialog<Row extends MasterRow, Form extends FieldValues>({ config, onClose, onImported }: Props<Row, Form>) {
  const titleId = useId()
  const [csv, setCsv] = useState('')
  const [checked, setChecked] = useState<ImportResult | null>(null)
  const [problems, setProblems] = useState<RowProblem[]>([])
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && busy === null) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  function edit(text: string) {
    setCsv(text)
    setChecked(null)
    setProblems([])
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) edit(await file.text())
  }

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'check' : 'apply')
    setProblems([])
    try {
      const result = await importMasters(config.apiPath, csv, dryRun)
      if (dryRun) setChecked(result)
      else onImported(result)
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) {
        setProblems((e.details as { row?: number; message?: string }[]).map((d) => ({ row: d.row, message: d.message ?? e.message })))
      } else {
        setProblems([{ message: e instanceof ApiError ? e.message : 'Could not read that file. Try again.' }])
      }
      setChecked(null)
    } finally {
      setBusy(null)
    }
  }

  const canApply = checked !== null && checked.created.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Import {config.plural} from CSV
        </h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Columns: <span className="font-mono text-xs">{config.importCsv?.columns}</span>. Up to 500 rows. Rows that already exist are skipped.
        </p>

        <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto">
          <label className="block text-sm font-medium">
            CSV file
            <input type="file" accept=".csv,text/csv" onChange={chooseFile} className="mt-1.5 block w-full text-sm" />
          </label>
          <label className="block text-sm font-medium">
            Or paste the rows
            <textarea
              rows={6}
              value={csv}
              onChange={(e) => edit(e.target.value)}
              placeholder={config.importCsv?.example}
              spellCheck={false}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
          </label>

          {problems.length > 0 ? (
            <div role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
              <p className="font-semibold">Nothing was imported. Fix these and check again:</p>
              <table className="mt-2 w-full text-left text-xs">
                <tbody>
                  {problems.map((p, i) => (
                    <tr key={i}>
                      <td className="w-16 py-0.5 pr-2 align-top font-semibold">{p.row ? `Row ${p.row}` : 'File'}</td>
                      <td className="py-0.5">{p.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {checked ? (
            <div role="status" className="rounded-lg bg-[var(--color-good-soft)] px-3 py-2.5 text-sm text-[var(--color-good)]">
              <p className="font-semibold">
                {checked.created.length} to add, {checked.skipped.length} already exist (skipped), out of {checked.total} rows.
              </p>
              {checked.skipped.length > 0 ? (
                <ul className="mt-1.5 list-disc pl-5 text-xs">
                  {checked.skipped.map((s) => (
                    <li key={s.row}>
                      Row {s.row}: {s.label} — {s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${button} border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]`} disabled={busy !== null} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${button} border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]`}
            disabled={busy !== null || csv.trim() === ''}
            onClick={() => run(true)}
          >
            {busy === 'check' ? 'Checking…' : 'Check file'}
          </button>
          <button
            type="button"
            className={`${button} bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]`}
            disabled={busy !== null || !canApply}
            onClick={() => run(false)}
          >
            {busy === 'apply' ? 'Importing…' : canApply ? `Import ${checked!.created.length} ${config.plural}` : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
