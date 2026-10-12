import type { FeeDetail, FeeSummary, Version } from './api/paymentConfig.api'

export const version = (over: Partial<Version> = {}): Version => ({
  id: 'v1',
  feeCode: 'PARENT_SUBSCRIPTION_YEARLY',
  version: 3,
  name: 'Parent membership · Yearly',
  description: 'Everything in monthly plus refund guarantee',
  isEnabled: true,
  amountPaise: 199900,
  currency: 'INR',
  gstInclusive: true,
  gstRateBps: 1800,
  billingPeriod: 'yearly',
  validityDays: 365,
  trialDays: 7,
  status: 'active',
  effectiveFrom: '2026-09-18T06:12:00.000Z',
  effectiveTo: null,
  changeReason: 'Launch pricing',
  publishedAt: '2026-09-18T06:12:00.000Z',
  publishedBy: { id: 'a1', name: 'Farah Khan' },
  createdAt: '2026-09-18T06:00:00.000Z',
  updatedAt: '2026-09-18T06:12:00.000Z',
  ...over,
})

export const summary = (over: Partial<FeeSummary> = {}): FeeSummary => ({
  feeCode: 'PARENT_SUBSCRIPTION_YEARLY',
  active: version(),
  scheduled: null,
  draft: null,
  usage30d: { captured: 412, revenuePaise: 82358800 },
  ...over,
})

export const detail = (over: Partial<FeeDetail> = {}): FeeDetail => ({ ...summary(), versions: [version()], ...over })

export const meta = (total = 1) => ({ page: 1, pageSize: 20, total, totalPages: 1 })
