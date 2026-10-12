import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchFees, toggleFee } from '../api/paymentConfig.api'
import type { FeeSummary } from '../api/paymentConfig.api'
import { ConfigHistoryTimeline } from '../components/ConfigHistoryTimeline'
import { FeeCard } from '../components/FeeCard'
import { ReasonDialog } from '../components/ReasonDialog'

export function PaymentConfigPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const fees = useQuery({ queryKey: ['payment-config', 'fees'], queryFn: fetchFees })
  const [toggling, setToggling] = useState<{ fee: FeeSummary; next: boolean } | null>(null)

  if (fees.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading fees…</p>
  if (fees.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{fees.error instanceof ApiError ? fees.error.message : 'Could not load the fees.'}</p>
        <button type="button" className="mt-3 font-medium text-[var(--color-accent)] hover:underline" onClick={() => fees.refetch()}>
          Try again
        </button>
      </div>
    )
  }

  const canPublish = can('payment_config.publish')
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold">Payment configuration</h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Every fee the platform charges. Changes are versioned, can be scheduled, and never alter what someone already started paying.</p>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {fees.data.map((fee) => (
          <FeeCard key={fee.feeCode} fee={fee} canPublish={canPublish} busy={false} onToggle={(f, next) => setToggling({ fee: f, next })} />
        ))}
      </ul>

      <section className="mt-10" aria-labelledby="pc-history">
        <h2 id="pc-history" className="mb-4 text-base font-semibold">
          Change history
        </h2>
        <ConfigHistoryTimeline />
      </section>

      {toggling ? (
        <ReasonDialog
          title={toggling.next ? `Switch on ${toggling.fee.active?.name ?? toggling.fee.feeCode}?` : `Switch off ${toggling.fee.active?.name ?? toggling.fee.feeCode}?`}
          description={toggling.next ? 'Users will see the purchase option again at the current price.' : 'The app hides the purchase and skips this payment. Anyone who has already paid keeps what they bought.'}
          confirmLabel={toggling.next ? 'Switch on' : 'Switch off'}
          tone={toggling.next ? 'default' : 'danger'}
          onClose={() => setToggling(null)}
          onSubmit={async (reason) => {
            await toggleFee(toggling.fee.feeCode, { enabled: toggling.next, reason })
            await queryClient.invalidateQueries({ queryKey: ['payment-config'] })
            setToggling(null)
          }}
        />
      ) : null}
    </div>
  )
}
