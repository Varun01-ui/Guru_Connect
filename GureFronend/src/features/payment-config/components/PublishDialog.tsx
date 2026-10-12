import { useState } from 'react'
import { priceChangePercent } from '../feeRules'
import type { Preview } from '../api/paymentConfig.api'
import { HandledError, ReasonDialog } from './ReasonDialog'

type Props = {
  feeName: string
  /** Live price and the draft's, to say how big the change is. */
  currentPaise: number | null
  draftPaise: number
  impact: Preview['impact'] | null
  onPublish: (input: { effectiveFrom?: string; reason: string; confirmLargeChange: boolean }) => Promise<void>
  onClose: () => void
}

// Admins think in IST. The picker is a plain datetime-local, read as Indian time whatever the browser's zone is.
const toIstInstant = (local: string) => new Date(`${local}:00+05:30`).toISOString()

export function PublishDialog({ feeName, currentPaise, draftPaise, impact, onPublish, onClose }: Props) {
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [when, setWhen] = useState('')
  const [whenError, setWhenError] = useState<string | null>(null)
  const percent = currentPaise === null ? null : priceChangePercent(currentPaise, draftPaise)

  return (
    <ReasonDialog
      title={`Publish ${feeName}`}
      description="Open checkouts keep the price they started with. Existing subscriptions keep theirs until renewal."
      confirmLabel={mode === 'now' ? 'Publish now' : 'Schedule change'}
      onClose={onClose}
      onSubmit={async (reason, confirmLargeChange) => {
        if (mode === 'schedule') {
          const instant = when ? new Date(`${when}:00+05:30`) : null
          if (!instant || Number.isNaN(instant.getTime())) {
            setWhenError('Pick when the change should start.')
            throw new HandledError()
          }
          setWhenError(null)
          await onPublish({ effectiveFrom: toIstInstant(when), reason, confirmLargeChange })
        } else await onPublish({ reason, confirmLargeChange })
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium">When</legend>
        <div className="mt-2 flex gap-2">
          {(['now', 'schedule'] as const).map((m) => (
            <label key={m} className={`flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${mode === m ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              <input type="radio" name="publish-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--color-accent)]" />
              {m === 'now' ? 'Publish now' : 'Schedule'}
            </label>
          ))}
        </div>
        {mode === 'schedule' ? (
          <div className="mt-3">
            <label htmlFor="pc-when" className="text-sm font-medium">
              Starts (IST)
            </label>
            <input id="pc-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-invalid={whenError ? true : undefined} className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-bad)]" />
            {whenError ? (
              <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
                {whenError}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <ul className="space-y-1 rounded-lg bg-[var(--color-surface-2)] px-4 py-3 text-sm" aria-label="Impact">
        {percent !== null ? (
          <li>
            Price change: <strong>{percent > 0 ? '+' : ''}{percent}%</strong>
          </li>
        ) : null}
        {impact ? (
          <>
            <li>
              <strong>{impact.liveSubscriptionsOnCurrentVersion.toLocaleString('en-IN')}</strong> live subscriptions keep their current price until they renew.
            </li>
            <li>
              <strong>{impact.openCheckouts.toLocaleString('en-IN')}</strong> checkouts are open right now and keep the price they started with.
            </li>
          </>
        ) : null}
      </ul>
    </ReasonDialog>
  )
}
