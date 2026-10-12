import { useId, useState } from 'react'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'
import { paiseToRupeesText, rupeesTextToPaise } from '../../../lib/money'
import type { BillingPeriod, Fields } from '../api/paymentConfig.api'
import { FEES, GST_RATES, PERIOD_LABELS } from '../feeRules'

type Props = {
  feeCode: string
  values: Fields
  errors: Record<string, string>
  disabled?: boolean
  onChange: (patch: Partial<Fields>) => void
}

const input =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:opacity-60'

// ₹ in the box, integer paise in the state. The text is kept while typing and only snapped to a clean amount on blur.
function MoneyInput({ value, invalid, disabled, onChange, id }: { value: number; invalid: boolean; disabled?: boolean; onChange: (paise: number) => void; id: string }) {
  const [text, setText] = useState(paiseToRupeesText(value))
  const [bad, setBad] = useState(false)
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 mt-[3px] -translate-y-1/2 text-sm text-[var(--color-fg-muted)]">
        ₹
      </span>
      <input
        id={id}
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-invalid={invalid || bad ? true : undefined}
        onChange={(e) => {
          setText(e.target.value)
          const paise = rupeesTextToPaise(e.target.value)
          setBad(paise === null)
          if (paise !== null) onChange(paise)
        }}
        onBlur={() => {
          const paise = rupeesTextToPaise(text)
          if (paise !== null) setText(paiseToRupeesText(paise))
        }}
        className={`${input} h-10 pl-7`}
      />
      {bad ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
          Enter an amount in rupees, like 1799 or 999.50.
        </p>
      ) : null}
    </div>
  )
}

export function FeeDraftForm({ feeCode, values, errors, disabled, onChange }: Props) {
  const uid = useId()
  const meta = FEES[feeCode]
  const periods: BillingPeriod[] = meta?.periods ?? [values.billingPeriod]
  const error = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
        {errors[key]}
      </p>
    ) : null

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-xl bg-[var(--color-surface-2)] px-4 py-3">
        <div>
          <div className="text-sm font-medium">Enabled</div>
          <div className="text-xs text-[var(--color-fg-muted)]">When off, the app hides the purchase and skips this payment.</div>
        </div>
        <StatusSwitch checked={values.isEnabled} label="Enabled" disabled={disabled} onChange={(isEnabled) => onChange({ isEnabled })} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-name`} className="text-sm font-medium">
            Display name
          </label>
          <input id={`${uid}-name`} value={values.name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} aria-invalid={errors.name ? true : undefined} className={`${input} h-10`} />
          {error('name')}
        </div>
        <div>
          <label htmlFor={`${uid}-amount`} className="text-sm font-medium">
            Price
          </label>
          <MoneyInput id={`${uid}-amount`} value={values.amountPaise} invalid={Boolean(errors.amountPaise)} disabled={disabled} onChange={(amountPaise) => onChange({ amountPaise })} />
          {error('amountPaise')}
        </div>
      </div>

      <div>
        <label htmlFor={`${uid}-desc`} className="text-sm font-medium">
          Description <span className="font-normal text-[var(--color-fg-muted)]">(optional)</span>
        </label>
        <textarea id={`${uid}-desc`} rows={2} value={values.description ?? ''} disabled={disabled} onChange={(e) => onChange({ description: e.target.value === '' ? null : e.target.value })} aria-invalid={errors.description ? true : undefined} className={`${input} py-2`} />
        {error('description')}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`${uid}-period`} className="text-sm font-medium">
            Billing period
          </label>
          <select id={`${uid}-period`} value={values.billingPeriod} disabled={disabled || periods.length === 1} onChange={(e) => onChange({ billingPeriod: e.target.value as BillingPeriod })} aria-invalid={errors.billingPeriod ? true : undefined} className={`${input} h-10`}>
            {periods.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
          {periods.length === 1 ? <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Fixed for this fee.</p> : null}
          {error('billingPeriod')}
        </div>
        <div>
          <label htmlFor={`${uid}-validity`} className="text-sm font-medium">
            Validity (days)
          </label>
          <input
            id={`${uid}-validity`}
            type="number"
            min={1}
            max={1095}
            value={values.validityDays ?? ''}
            disabled={disabled || values.billingPeriod === 'per_use'}
            onChange={(e) => onChange({ validityDays: e.target.value === '' ? null : Number(e.target.value) })}
            aria-invalid={errors.validityDays ? true : undefined}
            className={`${input} h-10`}
          />
          {error('validityDays')}
        </div>
        {meta?.subscription ? (
          <div>
            <label htmlFor={`${uid}-trial`} className="text-sm font-medium">
              Free trial (days)
            </label>
            <input id={`${uid}-trial`} type="number" min={0} max={90} value={values.trialDays} disabled={disabled} onChange={(e) => onChange({ trialDays: Number(e.target.value) })} aria-invalid={errors.trialDays ? true : undefined} className={`${input} h-10`} />
            {error('trialDays')}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center justify-between rounded-xl bg-[var(--color-surface-2)] px-4 py-3">
          <div className="text-sm font-medium">Price includes GST</div>
          <StatusSwitch checked={values.gstInclusive} label="Price includes GST" disabled={disabled} onChange={(gstInclusive) => onChange({ gstInclusive })} />
        </div>
        <div>
          <label htmlFor={`${uid}-gst`} className="text-sm font-medium">
            GST rate
          </label>
          <select id={`${uid}-gst`} value={values.gstRateBps} disabled={disabled} onChange={(e) => onChange({ gstRateBps: Number(e.target.value) })} className={`${input} h-10`}>
            {GST_RATES.map((r) => (
              <option key={r} value={r}>
                {r / 100}%
              </option>
            ))}
          </select>
          {error('gstRateBps')}
        </div>
      </div>
    </div>
  )
}
