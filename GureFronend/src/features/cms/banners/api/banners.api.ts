import { apiFetch, apiFetchPage } from '../../../../lib/api'
import type { PageMeta } from '../../../../lib/api'

export const PLACEMENTS = [
  { value: 'home_top', label: 'Home · top' },
  { value: 'home_middle', label: 'Home · middle' },
  { value: 'search_inline', label: 'Search results' },
  { value: 'teacher_dashboard', label: 'Teacher dashboard' },
  { value: 'institute_dashboard', label: 'Institute dashboard' },
  { value: 'onboarding', label: 'Onboarding' },
] as const
export type Placement = (typeof PLACEMENTS)[number]['value']

export const AUDIENCES = [
  { value: 'all', label: 'Everyone' },
  { value: 'parents', label: 'Parents' },
  { value: 'students', label: 'Students' },
  { value: 'teachers', label: 'Teachers' },
  { value: 'institutes', label: 'Institutes' },
] as const
export type Audience = (typeof AUDIENCES)[number]['value']

export type BannerStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'expired'

export type Banner = {
  id: string
  status: BannerStatus
  title: string
  subtitle: string | null
  image: { fileId: string; url: string | null }
  placement: Placement
  audience: Audience
  cities: { id: string; name: string }[]
  deepLink: string | null
  priority: number
  startsAt: string
  endsAt: string | null
  impressions: number
  clicks: number
  ctrPct: number | null
  createdAt: string
  updatedAt: string
}

export type BannerInput = {
  title: string
  subtitle: string | null
  imageFileId: string
  placement: Placement
  audience: Audience
  cityIds: string[]
  deepLink: string | null
  priority: number
  startsAt: string
  endsAt: string | null
}

export type BannerListParams = { page: number; pageSize: number; placement?: Placement; status?: BannerStatus; q?: string; sort?: string }

export type PreviewBanner = { id: string; title: string; subtitle: string | null; imageUrl: string | null; deepLink: string | null; placement: Placement; priority: number }
export type BannerPreview = { audience: string; cityId: string | null; placements: Record<Placement, PreviewBanner[]> }

export function fetchBanners(params: BannerListParams): Promise<{ data: Banner[]; meta: PageMeta }> {
  const qs = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.placement) qs.set('placement', params.placement)
  if (params.status) qs.set('status', params.status)
  if (params.q) qs.set('q', params.q)
  if (params.sort) qs.set('sort', params.sort)
  return apiFetchPage<Banner[]>(`/banners?${qs}`)
}

export const fetchBanner = (id: string) => apiFetch<Banner>(`/banners/${id}`)
export const createBanner = (body: BannerInput) => apiFetch<Banner>('/banners', { method: 'POST', body: JSON.stringify(body) })
export const patchBanner = (id: string, body: Partial<BannerInput>, version: string) =>
  apiFetch<Banner>(`/banners/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'If-Match': version } })
export const publishBanner = (id: string) => apiFetch<Banner>(`/banners/${id}/publish`, { method: 'POST' })
export const pauseBanner = (id: string) => apiFetch<Banner>(`/banners/${id}/pause`, { method: 'POST' })
export const resumeBanner = (id: string) => apiFetch<Banner>(`/banners/${id}/resume`, { method: 'POST' })
export const deleteBanner = (id: string) => apiFetch<undefined>(`/banners/${id}`, { method: 'DELETE' })
export const reorderBanners = (placement: Placement, ids: string[]) => apiFetch<Banner[]>('/banners/reorder', { method: 'POST', body: JSON.stringify({ placement, ids }) })
export const previewBanners = (audience: string, cityId?: string) =>
  apiFetch<BannerPreview>(`/banners/preview?audience=${audience}${cityId ? `&cityId=${cityId}` : ''}`)

export type CityOption = { id: string; name: string }
export const fetchCityOptions = () => apiFetch<CityOption[]>('/cities?fields=id,name&active=true')
