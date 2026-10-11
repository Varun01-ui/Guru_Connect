import { useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import type { DefaultValues, FieldValues, Path } from 'react-hook-form'
import { ApiError } from '../../../lib/api'
import { zodResolver } from '../../../lib/zodResolver'
import { createMaster, getMaster, updateMaster } from '../api/masters.api'
import type { MasterConfig, MasterField, MasterRow } from '../types'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  /** null opens the create form. */
  row: Row | null
  onClose: () => void
  onSaved: (row: Row, mode: 'created' | 'updated') => void
}

const inputClass =
  'mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)]'

// Only the fields whose value changed travel in a PATCH, so two admins editing different fields don't overwrite each other.
function changedFields(next: Record<string, unknown>, base: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== base[key]))
}

export function MasterFormDrawer<Row extends MasterRow, Form extends FieldValues>({ config, row, onClose, onSaved }: Props<Row, Form>) {
  const titleId = useId()
  const [base, setBase] = useState<Row | null>(row)
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Form>({
    resolver: zodResolver(config.schema),
    defaultValues: (row ? config.toFormValues(row) : config.defaultValues) as DefaultValues<Form>,
  })

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isSubmitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isSubmitting, onClose])

  const fieldNames = new Set(config.fields.map((f) => f.name))

  function showApiError(error: unknown) {
    if (!(error instanceof ApiError)) {
      setFormError(`Could not save this ${config.singular}. Try again.`)
      return
    }
    if (error.code === 'VALIDATION_FAILED' && Array.isArray(error.details)) {
      const leftovers: string[] = []
      for (const issue of error.details as { path?: string; message?: string }[]) {
        if (issue.path && fieldNames.has(issue.path)) setError(issue.path as Path<Form>, { type: 'server', message: issue.message })
        else if (issue.message) leftovers.push(issue.message)
      }
      setFormError(leftovers.length > 0 ? leftovers.join(' ') : null)
      return
    }
    if (error.code === 'CONFLICT_DUPLICATE') {
      const field = (error.details as { field?: string } | undefined)?.field
      if (field && fieldNames.has(field)) {
        setError(field as Path<Form>, { type: 'server', message: error.message })
        return
      }
    }
    if (error.code === 'VERSION_CONFLICT') setStale(true)
    setFormError(error.message)
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      if (!base) {
        onSaved(await createMaster<Row>(config.apiPath, config.toPayload(values)), 'created')
        return
      }
      const payload = changedFields(config.toPayload(values), config.toPayload(config.toFormValues(base)))
      if (Object.keys(payload).length === 0) {
        onClose()
        return
      }
      onSaved(await updateMaster<Row>(config.apiPath, base.id, payload, base.updatedAt), 'updated')
    } catch (error) {
      showApiError(error)
    }
  })

  async function reload() {
    if (!base) return
    try {
      const fresh = await getMaster<Row>(config.apiPath, base.id)
      setBase(fresh)
      reset(config.toFormValues(fresh) as DefaultValues<Form>)
      setStale(false)
      setFormError(null)
    } catch (error) {
      showApiError(error)
    }
  }

  function renderField(field: MasterField, index: number) {
    const id = `${titleId}-${field.name}`
    const errorId = `${id}-error`
    const message = (errors as Record<string, { message?: string } | undefined>)[field.name]?.message
    const name = field.name as Path<Form>

    if (field.kind === 'switch') {
      return (
        <div key={field.name} className="flex items-start justify-between gap-4 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
          <div>
            <label htmlFor={id} className="text-sm font-medium">
              {field.label}
            </label>
            {field.hint ? <p className="text-xs text-[var(--color-fg-muted)]">{field.hint}</p> : null}
          </div>
          <input id={id} type="checkbox" role="switch" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" {...register(name)} />
        </div>
      )
    }

    return (
      <div key={field.name}>
        <label htmlFor={id} className="text-sm font-medium">
          {field.label}
        </label>
        <input
          id={id}
          autoFocus={index === 0}
          type={field.kind === 'number' ? 'number' : 'text'}
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          autoComplete="off"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          className={inputClass}
          {...register(name, field.kind === 'number' ? { valueAsNumber: true } : undefined)}
        />
        {message ? (
          <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
            {message}
          </p>
        ) : field.hint ? (
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{field.hint}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose()
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="h-full w-full max-w-md animate-[fade-in_0.2s_ease-out] overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {base ? `Edit ${config.singular}` : `Add ${config.singular}`}
        </h2>

        <form className="mt-5 space-y-4" onSubmit={onSubmit} noValidate>
          {config.fields.map(renderField)}

          {formError ? (
            <div role="alert" className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
              <p>{formError}</p>
              {stale ? (
                <button type="button" className="mt-1.5 font-semibold underline" onClick={reload}>
                  Reload latest
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]"
              disabled={isSubmitting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting || stale}
            >
              {isSubmitting ? 'Saving…' : base ? 'Save changes' : `Add ${config.singular}`}
            </button>
          </div>
        </form>
      </aside>
    </div>
  )
}
