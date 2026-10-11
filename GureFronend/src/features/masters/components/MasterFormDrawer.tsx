import { useEffect, useId, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import type { DefaultValues, FieldValues, Path, UseFormRegisterReturn } from 'react-hook-form'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { ApiError } from '../../../lib/api'
import { zodResolver } from '../../../lib/zodResolver'
import { createMaster, getMaster, updateMaster } from '../api/masters.api'
import { useOptions } from '../hooks/useOptions'
import type { MasterConfig, MasterField, MasterRow, SelectOption } from '../types'

type Props<Row extends MasterRow, Form extends FieldValues> = {
  config: MasterConfig<Row, Form>
  /** null opens the create form. */
  row: Row | null
  onClose: () => void
  onSaved: (row: Row, mode: 'created' | 'updated') => void
}

const inputClass =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-fg-muted)] read-only:cursor-not-allowed read-only:bg-[var(--color-surface-2)] read-only:text-[var(--color-fg-muted)]'

// Only the fields whose value changed travel in a PATCH, so two admins editing different fields don't overwrite each other.
function changedFields(next: Record<string, unknown>, base: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== base[key]))
}

type SelectProps = {
  id: string
  field: MasterField
  register: UseFormRegisterReturn
  disabled: boolean
  invalid: boolean
  describedBy?: string
  /** The row's current choice, kept selectable even when it is no longer among the active options. */
  current: SelectOption | null
}

function SelectInput({ id, field, register, disabled, invalid, describedBy, current }: SelectProps) {
  const remote = useOptions(field.optionsFrom)
  const options = [...(field.options ?? []), ...(remote.data ?? [])]
  if (current && !options.some((o) => o.value === current.value)) options.unshift(current)
  return (
    <select id={id} className={`${inputClass} h-10`} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy} disabled={disabled} {...register}>
      <option value="">{remote.isPending && field.optionsFrom ? 'Loading…' : 'Select…'}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function MasterFormDrawer<Row extends MasterRow, Form extends FieldValues>({ config, row, onClose, onSaved }: Props<Row, Form>) {
  const titleId = useId()
  const [base, setBase] = useState<Row | null>(row)
  const [formError, setFormError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null)

  // Fields that cannot change on an existing row (stable codes, built-in rows). Disabled inputs report no value to
  // react-hook-form, so their stored value is put back before validating.
  const locked = new Set<string>(base ? [...config.fields.filter((f) => f.immutable).map((f) => f.name), ...(config.rowRules?.lockedFields?.(base) ?? [])] : [])
  const lockedValues = base ? Object.fromEntries([...locked].map((name) => [name, (config.toFormValues(base) as Record<string, unknown>)[name]])) : {}
  const validate = zodResolver(config.schema)

  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<Form>({
    resolver: (values, context, options) => validate({ ...values, ...lockedValues }, context, options),
    defaultValues: (row ? config.toFormValues(row) : config.defaultValues) as DefaultValues<Form>,
  })

  const current = useWatch({ control }) as Record<string, unknown>
  const isShown = (field: MasterField) => !field.showWhen || String(current[field.showWhen.field] ?? '') === field.showWhen.equals

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

  // `skipConfirm` is true when the admin has just said yes to the confirmSave question.
  const submit = (skipConfirm: boolean) =>
    handleSubmit(async (values) => {
      setFormError(null)
      try {
        const payload = base ? changedFields(config.toPayload(values), config.toPayload(config.toFormValues(base))) : config.toPayload(values)
        if (base && Object.keys(payload).length === 0) {
          onClose()
          return
        }
        if (!skipConfirm) {
          const message = await config.confirmSave?.({ row: base, payload })
          if (message) {
            setPendingConfirm(message)
            return
          }
        }
        if (!base) onSaved(await createMaster<Row>(config.apiPath, payload), 'created')
        else onSaved(await updateMaster<Row>(config.apiPath, base.id, payload, base.updatedAt), 'updated')
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
    const isLocked = locked.has(field.name)
    const hint = isLocked ? (field.kind === 'switch' ? field.hint : (field.lockedHint ?? "Can't be changed after it is created.")) : field.hint

    if (field.kind === 'switch') {
      return (
        <div key={field.name} className="flex items-start justify-between gap-4 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
          <div>
            <label htmlFor={id} className="text-sm font-medium">
              {field.label}
            </label>
            {hint ? <p className="text-xs text-[var(--color-fg-muted)]">{isLocked ? `${hint} Built-in, so this can't change.` : hint}</p> : null}
          </div>
          <input id={id} type="checkbox" role="switch" disabled={isLocked} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" {...register(name)} />
        </div>
      )
    }

    const describedBy = message ? errorId : undefined
    let input
    if (field.kind === 'select') {
      input = (
        <SelectInput
          id={id}
          field={field}
          register={register(name)}
          disabled={isLocked}
          invalid={Boolean(message)}
          describedBy={describedBy}
          current={base ? (config.selectedOption?.(base, field.name) ?? null) : null}
        />
      )
    } else if (field.kind === 'textarea') {
      input = (
        <textarea
          id={id}
          rows={3}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          readOnly={isLocked}
          aria-invalid={message ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} py-2`}
          {...register(name)}
        />
      )
    } else {
      input = (
        <input
          id={id}
          autoFocus={index === 0 && !isLocked}
          type={field.kind === 'number' ? 'number' : 'text'}
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          autoComplete="off"
          readOnly={isLocked}
          aria-invalid={message ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} h-10`}
          {...register(name, field.kind === 'number' ? { valueAsNumber: true } : undefined)}
        />
      )
    }

    return (
      <div key={field.name}>
        <label htmlFor={id} className="text-sm font-medium">
          {field.label}
        </label>
        {input}
        {message ? (
          <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
            {message}
          </p>
        ) : hint ? (
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{hint}</p>
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

        <form className="mt-5 space-y-4" onSubmit={submit(false)} noValidate>
          {config.fields.filter(isShown).map(renderField)}

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

        {pendingConfirm ? (
          <ConfirmDialog
            title={base ? `Save changes to ${base.name}?` : `Add this ${config.singular}?`}
            message={pendingConfirm}
            confirmLabel="Yes, continue"
            onCancel={() => setPendingConfirm(null)}
            onConfirm={() => {
              setPendingConfirm(null)
              void submit(true)()
            }}
          />
        ) : null}
      </aside>
    </div>
  )
}
