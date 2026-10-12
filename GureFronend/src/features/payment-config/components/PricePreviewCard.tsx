import type { PriceCard } from '../api/paymentConfig.api'

// The exact card the app will show, as the server builds it, so what the admin approves is what users get.
export function PricePreviewCard({ card }: { card: PriceCard }) {
  return (
    <figure aria-label="What users will see" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
      <figcaption className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">What users will see</figcaption>
      <h3 className="mt-2 text-base font-semibold">{card.title}</h3>
      {card.enabled ? (
        <>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{card.priceText}</p>
          <ul className="mt-1 space-y-0.5 text-sm text-[var(--color-fg-muted)]">
            {card.perMonthText ? <li>{card.perMonthText}</li> : null}
            {card.gstText ? <li>{card.gstText}</li> : null}
            {card.trialText ? <li className="font-medium text-[var(--color-good)]">{card.trialText}</li> : null}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">Switched off — users won’t see a price or a purchase button.</p>
      )}
    </figure>
  )
}
