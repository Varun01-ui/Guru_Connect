// All money is integer paise. Rounding is "half up", done with integer arithmetic only so there is no float drift.
export const roundDiv = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator))

export type FeeAmounts = { listPaise: number; walletPaise: number; payablePaise: number; basePaise: number; gstPaise: number }

// M43 BR-43.3. `walletBalancePaise` is the usable balance (0 when the wallet is off or empty).
export function computeAmounts(input: { amountPaise: number; gstInclusive: boolean; gstRateBps: number; walletBalancePaise: number; maxRedeemPercent: number }): FeeAmounts {
  const { amountPaise, gstInclusive, gstRateBps } = input
  const listPaise = gstInclusive ? amountPaise : amountPaise + roundDiv(amountPaise * gstRateBps, 10_000)
  const maxRedeem = Math.floor((listPaise * input.maxRedeemPercent) / 100)
  const walletPaise = input.walletBalancePaise > 0 ? Math.min(input.walletBalancePaise, maxRedeem) : 0
  const payablePaise = listPaise - walletPaise
  const basePaise = roundDiv(payablePaise * 10_000, 10_000 + gstRateBps)
  return { listPaise, walletPaise, payablePaise, basePaise, gstPaise: payablePaise - basePaise }
}
