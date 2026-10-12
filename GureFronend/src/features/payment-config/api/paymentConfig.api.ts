import { apiFetch, apiFetchPage } from '../../../lib/api'
import type { PageMeta } from '../../../lib/api'

export type BillingPeriod = 'one_time' | 'monthly' | 'quarterly' | 'yearly' | 'per_30_days' | 'per_use'
export type VersionStatus = 'draft' | 'scheduled' | 'active' | 'superseded' | 'cancelled'

export type Version = {
  id: string
  feeCode: string
  version: number
  name: string
  description: string | null
  isEnabled: boolean
  amountPaise: number
  currency: string
  gstInclusive: boolean
  gstRateBps: number
  billingPeriod: BillingPeriod
  validityDays: number | null
  trialDays: number
  status: VersionStatus
  effectiveFrom: string
  effectiveTo: string | null
  changeReason: string | null
  publishedAt: string | null
  publishedBy: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
}

// The part of a version an admin edits.
export type Fields = Pick<Version, 'name' | 'description' | 'isEnabled' | 'amountPaise' | 'gstInclusive' | 'gstRateBps' | 'billingPeriod' | 'validityDays' | 'trialDays'>

export type FeeSummary = {
  feeCode: string
  active: Version | null
  scheduled: Version | null
  draft: Version | null
  usage30d: { captured: number; revenuePaise: number }
}
export type FeeDetail = FeeSummary & { versions: Version[] }

export type PriceCard = { title: string; priceText: string; perMonthText: string | null; gstText: string | null; trialText: string | null; enabled: boolean }
export type Preview = { card: PriceCard; impact: { liveSubscriptionsOnCurrentVersion: number; openCheckouts: number; changePercent: number | null } }

export type Outcome = { feeCode: string; changed: Version; active: Version | null; scheduled: Version | null; draft: Version | null }

export type HistoryEntry = {
  id: string
  feeCode: string
  action: string
  versionId: string
  version: number
  oldValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  reason: string | null
  changedBy: { id: string; name: string } | null
  createdAt: string
}

export const fetchFees = () => apiFetch<FeeSummary[]>('/payment-configs')

export function fetchFee(feeCode: string, page = 1, status?: VersionStatus): Promise<{ data: FeeDetail; meta: PageMeta }> {
  const qs = new URLSearchParams({ page: String(page), pageSize: '20' })
  if (status) qs.set('status', status)
  return apiFetchPage<FeeDetail>(`/payment-configs/${feeCode}?${qs}`)
}

// `version` is the draft's updatedAt once a draft exists; the first save (which creates it) sends none.
export const saveDraft = (feeCode: string, body: Partial<Fields>, version?: string) =>
  apiFetch<Version>(`/payment-configs/${feeCode}/draft`, { method: 'PUT', body: JSON.stringify(body), headers: version ? { 'If-Match': version } : {} })

export const discardDraft = (feeCode: string) => apiFetch<undefined>(`/payment-configs/${feeCode}/draft`, { method: 'DELETE' })
export const previewDraft = (feeCode: string) => apiFetch<Preview>(`/payment-configs/${feeCode}/draft/preview`)

export const publishDraft = (feeCode: string, body: { effectiveFrom?: string; reason: string; confirmLargeChange?: boolean }) =>
  apiFetch<Outcome>(`/payment-configs/${feeCode}/draft/publish`, { method: 'POST', body: JSON.stringify(body) })

export const toggleFee = (feeCode: string, body: { enabled: boolean; reason: string }) => apiFetch<Outcome>(`/payment-configs/${feeCode}/toggle`, { method: 'POST', body: JSON.stringify(body) })

export const cancelVersion = (id: string, reason: string) => apiFetch<Outcome>(`/payment-configs/versions/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })

export const restoreVersion = (id: string, body: { effectiveFrom?: string; reason: string; confirmLargeChange?: boolean }) =>
  apiFetch<Outcome>(`/payment-configs/versions/${id}/restore`, { method: 'POST', body: JSON.stringify(body) })

export async function fetchHistory(params: { cursor?: string; feeCode?: string }): Promise<{ data: HistoryEntry[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ limit: '50' })
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.feeCode) qs.set('feeCode', params.feeCode)
  const page = await apiFetchPage<HistoryEntry[]>(`/payment-configs/history?${qs}`)
  return { data: page.data, nextCursor: (page.meta as unknown as { nextCursor: string | null }).nextCursor }
}
