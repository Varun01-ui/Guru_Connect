import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../../../../components/shared/ConfirmDialog'
import { StatusBadge } from '../../../../components/shared/StatusBadge'
import { ApiError } from '../../../../lib/api'
import { usePermissions } from '../../../auth/usePermissions'
import { createBanner, deleteBanner, fetchBanner, patchBanner, pauseBanner, publishBanner, resumeBanner } from '../api/banners.api'
import type { Banner } from '../api/banners.api'
import { BannerForm } from '../components/BannerForm'
import { PhonePreview } from '../components/PhonePreview'
import { changesOf, emptyForm, formFromBanner, payloadOf, validateForm } from '../form'
import type { FormValues } from '../form'

const primary = 'rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60'
const secondary = 'rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-60'

export function BannerEditorPage() {
  const { id } = useParams()
  const query = useQuery({ queryKey: ['banners', 'one', id], queryFn: () => fetchBanner(id!), enabled: Boolean(id) })
  const [reloads, setReloads] = useState(0)

  if (!id) return <Editor key="new" banner={null} onReload={() => undefined} />
  if (query.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading banner…</p>
  if (query.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{query.error instanceof ApiError ? query.error.message : 'Could not load the banner.'}</p>
        <Link to="/cms/banners" className="mt-3 inline-block font-medium text-[var(--color-accent)] hover:underline">
          Back to banners
        </Link>
      </div>
    )
  }
  return <Editor key={`${id}-${reloads}`} banner={query.data} onReload={() => void query.refetch().then(() => setReloads((n) => n + 1))} />
}

function Editor({ banner, onReload }: { banner: Banner | null; onReload: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const [saved, setSaved] = useState<Banner | null>(banner)
  const [baseline, setBaseline] = useState<FormValues>(() => (banner ? formFromBanner(banner) : emptyForm()))
  const [values, setValues] = useState<FormValues>(baseline)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const canManage = can('banners.manage')
  const expired = saved?.status === 'expired'
  const readOnly = !canManage || expired
  const dirty = saved ? Object.keys(changesOf(values, baseline)).length > 0 : true

  function adopt(next: Banner) {
    const form = formFromBanner(next)
    setSaved(next)
    setBaseline(form)
    setValues(form)
    queryClient.setQueryData(['banners', 'one', next.id], next)
    void queryClient.invalidateQueries({ queryKey: ['banners', 'list'] })
  }

  function fail(e: unknown, fallback: string) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setStale(true)
      return
    }
    if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
      const mapped: Record<string, string> = {}
      for (const d of e.details as { path?: string; message?: string }[]) if (d.path && d.message && !(d.path in mapped)) mapped[d.path] = d.message
      setErrors(mapped)
      if (Object.keys(mapped).length === 0) setFormError(e.message)
      return
    }
    setFormError(e instanceof ApiError ? e.message : fallback)
  }

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true)
    setFormError(null)
    try {
      await work()
    } catch (e) {
      fail(e, fallback)
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    const problems = validateForm(values)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    void run(async () => {
      if (!saved) {
        const created = await createBanner(payloadOf(values))
        void queryClient.invalidateQueries({ queryKey: ['banners', 'list'] })
        navigate(`/cms/banners/${created.id}`, { replace: true })
        return
      }
      adopt(await patchBanner(saved.id, changesOf(values, baseline), saved.updatedAt))
    }, 'Could not save the banner. Try again.')
  }

  const transition = (action: () => Promise<Banner>) => () =>
    void run(async () => {
      if (dirty) {
        setFormError('Save your changes first.')
        return
      }
      adopt(await action())
    }, 'That did not work. Try again.')

  const heading = saved ? saved.title : 'New banner'

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/cms/banners" className="text-sm font-medium text-[var(--color-accent)] hover:underline">
        ← Banners
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{heading}</h1>
        {saved ? <StatusBadge tone={{ draft: 'neutral', scheduled: 'info', active: 'good', paused: 'warn', expired: 'bad' }[saved.status] as 'good'}>{saved.status}</StatusBadge> : null}
      </div>
      {expired ? <p className="mt-2 text-sm text-[var(--color-fg-muted)]">This banner has ended, so it can’t be edited. Create a new one to run it again.</p> : null}
      {!canManage ? <p className="mt-2 text-sm text-[var(--color-fg-muted)]">You can view banners but not change them.</p> : null}

      {stale ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
          <span>Someone else changed this banner. Reload.</span>
          <button type="button" className="rounded-lg border border-[var(--color-warn)]/40 px-3 py-1.5 font-semibold" onClick={onReload}>
            Reload latest
          </button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <form
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <BannerForm values={values} errors={errors} disabled={readOnly || busy} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} />

          {saved ? (
            <dl className="mt-5 grid grid-cols-3 gap-3 rounded-xl bg-[var(--color-surface-2)] p-3 text-center text-xs">
              <div>
                <dt className="text-[var(--color-fg-muted)]">Impressions</dt>
                <dd className="text-base font-semibold">{saved.impressions.toLocaleString('en-IN')}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-fg-muted)]">Clicks</dt>
                <dd className="text-base font-semibold">{saved.clicks.toLocaleString('en-IN')}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-fg-muted)]">Click-through</dt>
                <dd className="text-base font-semibold">{saved.ctrPct === null ? '—' : `${saved.ctrPct}%`}</dd>
              </div>
            </dl>
          ) : null}

          {formError ? (
            <p role="alert" className="mt-4 rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
              {formError}
            </p>
          ) : null}

          {!readOnly ? (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {saved?.status === 'draft' ? (
                  <button type="button" className={secondary} disabled={busy} onClick={transition(() => publishBanner(saved.id))}>
                    Publish
                  </button>
                ) : null}
                {saved?.status === 'active' ? (
                  <button type="button" className={secondary} disabled={busy} onClick={transition(() => pauseBanner(saved.id))}>
                    Pause
                  </button>
                ) : null}
                {saved?.status === 'paused' ? (
                  <button type="button" className={secondary} disabled={busy} onClick={transition(() => resumeBanner(saved.id))}>
                    Resume
                  </button>
                ) : null}
                {saved && saved.status !== 'active' ? (
                  <button type="button" className={`${secondary} !text-[var(--color-bad)]`} disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                ) : null}
              </div>
              <button type="submit" className={primary} disabled={busy || !dirty}>
                {busy ? 'Saving…' : saved ? 'Save changes' : 'Create draft'}
              </button>
            </div>
          ) : null}
        </form>

        <aside aria-label="Live preview">
          <PhonePreview items={[{ title: values.title, subtitle: values.subtitle, imageUrl: values.imageUrl }]} caption="Live preview" />
        </aside>
      </div>

      {confirmDelete && saved ? (
        <ConfirmDialog
          title="Delete this banner?"
          message="It stops showing and disappears from the list. You can’t undo this from here."
          confirmLabel="Delete banner"
          tone="danger"
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            void run(async () => {
              await deleteBanner(saved.id)
              void queryClient.invalidateQueries({ queryKey: ['banners', 'list'] })
              navigate('/cms/banners')
            }, 'Could not delete the banner. Try again.').finally(() => setConfirmDelete(false))
          }
        />
      ) : null}
    </div>
  )
}
