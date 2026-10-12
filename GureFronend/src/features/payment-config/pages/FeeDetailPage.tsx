import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Pagination } from '../../../components/shared/Pagination'
import { StatusBadge } from '../../../components/shared/StatusBadge'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { formatRupees } from '../../../lib/money'
import { usePermissions } from '../../auth/usePermissions'
import { cancelVersion, discardDraft, fetchFee, previewDraft, publishDraft, restoreVersion, saveDraft } from '../api/paymentConfig.api'
import type { FeeDetail, Fields, Version } from '../api/paymentConfig.api'
import { ConfigHistoryTimeline } from '../components/ConfigHistoryTimeline'
import { FeeDraftForm } from '../components/FeeDraftForm'
import { PricePreviewCard } from '../components/PricePreviewCard'
import { PublishDialog } from '../components/PublishDialog'
import { ReasonDialog } from '../components/ReasonDialog'
import { VersionTable } from '../components/VersionTable'
import { diffFields, feeLabel, fieldProblems, fieldsOf } from '../feeRules'

const AUTOSAVE_MS = 1000
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function FeeDetailPage() {
  const { feeCode = '' } = useParams()
  const [page, setPage] = useState(1)
  const [reloads, setReloads] = useState(0)
  const query = useQuery({ queryKey: ['payment-config', 'fee', feeCode, page], queryFn: () => fetchFee(feeCode, page) })

  if (query.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading fee…</p>
  if (query.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{query.error instanceof ApiError ? query.error.message : 'Could not load this fee.'}</p>
        <Link to="/payments/config" className="mt-3 inline-block font-medium text-[var(--color-accent)] hover:underline">
          Back to payment configuration
        </Link>
      </div>
    )
  }
  return (
    <Detail
      key={`${feeCode}-${reloads}`}
      detail={query.data.data}
      meta={query.data.meta}
      page={page}
      onPage={setPage}
      onReload={async () => {
        await query.refetch()
        setReloads((n) => n + 1)
      }}
    />
  )
}

type DetailProps = { detail: FeeDetail; meta: { page: number; pageSize: number; total: number; totalPages: number }; page: number; onPage: (p: number) => void; onReload: () => Promise<void> }

function Detail({ detail, meta, onPage, onReload }: DetailProps) {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canEdit = can('payment_config.edit')
  const canPublish = can('payment_config.publish')
  const { feeCode, active, scheduled } = detail
  const name = active?.name ?? feeLabel(feeCode)

  // ---- the editor: a local copy of the fields, autosaved as a draft one second after the last keystroke ----
  const start = detail.draft ?? active
  const [draft, setDraft] = useState<Version | null>(detail.draft)
  const [fields, setFields] = useState<Fields | null>(start ? fieldsOf(start) : null)
  const server = useRef<Fields | null>(start ? fieldsOf(start) : null)
  const version = useRef<string | undefined>(detail.draft?.updatedAt)
  const inFlight = useRef(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [revision, setRevision] = useState(0) // bumps after every successful save so the preview refreshes

  const unsaved = Boolean(fields && server.current && Object.keys(diffFields(fields, server.current)).length > 0)

  async function flush(current: Fields) {
    if (inFlight.current || !server.current) return
    const problems = fieldProblems(feeCode, current)
    setErrors(problems)
    if (Object.keys(problems).length > 0) {
      setSaveState('error')
      setSaveError(null)
      return
    }
    const patch = diffFields(current, server.current)
    if (Object.keys(patch).length === 0) return
    inFlight.current = true
    setSaveState('saving')
    setSaveError(null)
    try {
      const saved = await saveDraft(feeCode, patch, version.current)
      server.current = fieldsOf(saved)
      version.current = saved.updatedAt
      setDraft(saved)
      setRevision((n) => n + 1)
      setSaveState('saved')
      void queryClient.invalidateQueries({ queryKey: ['payment-config', 'fees'] })
    } catch (e) {
      setSaveState('error')
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setStale(true)
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
        const mapped: Record<string, string> = {}
        for (const d of e.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in mapped)) mapped[d.path] = d.message
        setErrors(mapped)
        if (Object.keys(mapped).length === 0) setSaveError(e.message)
      } else setSaveError(e instanceof ApiError ? e.message : 'Could not save the draft. Check your connection.')
    } finally {
      inFlight.current = false
    }
  }

  // Latest-value ref so the timer always saves what is on screen, and keeps going if more was typed during a save.
  const latest = useRef(fields)
  latest.current = fields
  useEffect(() => {
    if (!canEdit || !fields || !server.current || stale) return
    if (Object.keys(diffFields(fields, server.current)).length === 0) return
    const timer = setTimeout(() => void flush(latest.current ?? fields), AUTOSAVE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, revision, stale, canEdit])

  const preview = useQuery({ queryKey: ['payment-config', 'preview', feeCode, draft?.updatedAt, revision], queryFn: () => previewDraft(feeCode), enabled: Boolean(draft) && !unsaved })

  const [dialog, setDialog] = useState<null | 'publish' | 'discard' | { kind: 'cancel' | 'restore'; version: Version }>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const done = async () => {
    setDialog(null)
    await queryClient.invalidateQueries({ queryKey: ['payment-config'] })
    await onReload()
  }

  const status: Record<SaveState, string> = { idle: draft ? 'Draft saved' : 'No changes yet', saving: 'Saving…', saved: 'All changes saved', error: 'Not saved' }

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/payments/config" className="text-sm font-medium text-[var(--color-accent)] hover:underline">
        ← Payment configuration
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{name}</h1>
        <code className="text-xs text-[var(--color-fg-muted)]">{feeCode}</code>
        {active ? <StatusBadge tone={active.isEnabled ? 'good' : 'warn'}>{active.isEnabled ? 'On' : 'Off'}</StatusBadge> : null}
      </div>
      {active ? (
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Live now: <strong className="text-[var(--color-fg)]">{formatRupees(active.amountPaise)}</strong> (v{active.version}, since {formatDateTime(active.effectiveFrom)})
        </p>
      ) : null}

      {scheduled ? (
        <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-info)]/30 bg-[var(--color-info-soft)] px-4 py-3 text-sm text-[var(--color-info)]">
          <span>
            Scheduled: <strong>{formatRupees(scheduled.amountPaise)}</strong> from {formatDateTime(scheduled.effectiveFrom)}
            {scheduled.changeReason ? ` — “${scheduled.changeReason}”` : ''}
          </span>
          {canPublish ? (
            <button type="button" className="rounded-lg border border-current px-3 py-1.5 font-semibold" onClick={() => setDialog({ kind: 'cancel', version: scheduled })}>
              Cancel this change
            </button>
          ) : null}
        </div>
      ) : null}

      {stale ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
          <span>This draft changed in another tab.</span>
          <button type="button" className="rounded-lg border border-[var(--color-warn)]/40 px-3 py-1.5 font-semibold" onClick={() => void onReload()}>
            Reload latest
          </button>
        </div>
      ) : null}
      {!canEdit ? <p className="mt-4 rounded-lg bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-fg-muted)]">You can view this fee but not change it.</p> : null}

      {fields ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm" aria-labelledby="pc-draft">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 id="pc-draft" className="text-base font-semibold">
                {draft ? 'Draft' : 'Edit to start a draft'}
              </h2>
              <span role="status" aria-live="polite" className={`text-xs ${saveState === 'error' ? 'text-[var(--color-bad)]' : 'text-[var(--color-fg-muted)]'}`}>
                {unsaved && saveState !== 'saving' && saveState !== 'error' ? 'Unsaved changes…' : status[saveState]}
              </span>
            </div>
            <FeeDraftForm feeCode={feeCode} values={fields} errors={errors} disabled={!canEdit} onChange={(patch) => setFields((f) => (f ? { ...f, ...patch } : f))} />
            {saveError ? (
              <p role="alert" className="mt-4 rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
                {saveError}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" className="mt-4 rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
                {actionError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              {canEdit && draft ? (
                <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-bad)] hover:bg-[var(--color-surface-2)]" onClick={() => setDialog('discard')}>
                  Discard draft
                </button>
              ) : (
                <span />
              )}
              {canPublish ? (
                <button
                  type="button"
                  className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!draft || unsaved || saveState === 'saving'}
                  onClick={() => setDialog('publish')}
                >
                  Publish…
                </button>
              ) : null}
            </div>
          </section>

          <aside className="space-y-4" aria-label="Preview">
            {draft && preview.data ? (
              <>
                <PricePreviewCard card={preview.data.card} />
                {preview.data.impact.changePercent !== null ? (
                  <p className="text-center text-xs text-[var(--color-fg-muted)]">
                    {preview.data.impact.changePercent > 0 ? '+' : ''}
                    {preview.data.impact.changePercent}% against the live price
                  </p>
                ) : null}
              </>
            ) : (
              <p className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-sm text-[var(--color-fg-muted)]">{draft ? 'Loading the preview…' : 'Change something to see what users will see.'}</p>
            )}
          </aside>
        </div>
      ) : null}

      <section className="mt-10" aria-labelledby="pc-versions">
        <h2 id="pc-versions" className="mb-3 text-base font-semibold">
          All versions
        </h2>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <VersionTable versions={detail.versions} canPublish={canPublish} onCancel={(v) => setDialog({ kind: 'cancel', version: v })} onRestore={(v) => setDialog({ kind: 'restore', version: v })} />
          <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} totalPages={meta.totalPages} onPage={onPage} onPageSize={() => undefined} />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="pc-fee-history">
        <h2 id="pc-fee-history" className="mb-4 text-base font-semibold">
          Change history
        </h2>
        <ConfigHistoryTimeline feeCode={feeCode} />
      </section>

      {dialog === 'publish' && draft && preview.data ? (
        <PublishDialog
          feeName={name}
          currentPaise={active ? active.amountPaise : null}
          draftPaise={draft.amountPaise}
          impact={preview.data.impact}
          onClose={() => setDialog(null)}
          onPublish={async (input) => {
            await publishDraft(feeCode, { ...input, confirmLargeChange: input.confirmLargeChange || undefined })
            await done()
          }}
        />
      ) : null}
      {dialog === 'discard' ? (
        <ConfirmDialog
          title="Discard this draft?"
          message="Your unpublished changes are deleted. The live price is not affected."
          confirmLabel="Discard draft"
          tone="danger"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setActionError(null)
            discardDraft(feeCode)
              .then(done)
              .catch((e: unknown) => {
                setDialog(null)
                setActionError(e instanceof ApiError ? e.message : 'Could not discard the draft.')
              })
          }}
        />
      ) : null}
      {dialog && typeof dialog === 'object' && dialog.kind === 'cancel' ? (
        <ReasonDialog
          title={`Cancel the change scheduled for ${formatDateTime(dialog.version.effectiveFrom)}?`}
          description="The live price stays as it is."
          confirmLabel="Cancel the change"
          tone="danger"
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await cancelVersion(dialog.version.id, reason)
            await done()
          }}
        />
      ) : null}
      {dialog && typeof dialog === 'object' && dialog.kind === 'restore' ? (
        <ReasonDialog
          title={`Restore version ${dialog.version.version}?`}
          description={`A copy of it (${formatRupees(dialog.version.amountPaise)}) goes live now as a new version. History stays in order.`}
          confirmLabel="Restore now"
          onClose={() => setDialog(null)}
          onSubmit={async (reason, confirmLargeChange) => {
            await restoreVersion(dialog.version.id, { reason, ...(confirmLargeChange ? { confirmLargeChange: true } : {}) })
            await done()
          }}
        />
      ) : null}
    </div>
  )
}
