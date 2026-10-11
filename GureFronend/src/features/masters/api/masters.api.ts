import { apiFetch, apiFetchPage } from '../../../lib/api'
import type { PageMeta } from '../../../lib/api'
import type { MasterRow, SortKey } from '../types'

export type ListParams = {
  page: number
  pageSize: number
  q?: string
  active?: boolean
  sort?: { key: SortKey; dir: 'asc' | 'desc' }
  includeDeleted?: boolean
}

export function listMasters<Row extends MasterRow>(apiPath: string, params: ListParams): Promise<{ data: Row[]; meta: PageMeta }> {
  const qs = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.q) qs.set('q', params.q)
  if (params.active !== undefined) qs.set('active', String(params.active))
  if (params.sort) qs.set('sort', `${params.sort.key}:${params.sort.dir}`)
  if (params.includeDeleted) qs.set('includeDeleted', 'true')
  return apiFetchPage<Row[]>(`${apiPath}?${qs}`)
}

export function getMaster<Row extends MasterRow>(apiPath: string, id: string) {
  return apiFetch<Row>(`${apiPath}/${id}`)
}

export function createMaster<Row extends MasterRow>(apiPath: string, payload: Record<string, unknown>) {
  return apiFetch<Row>(apiPath, { method: 'POST', body: JSON.stringify(payload) })
}

// `version` is the row's updatedAt as last read; the API answers 409 VERSION_CONFLICT if someone saved since.
export function updateMaster<Row extends MasterRow>(apiPath: string, id: string, payload: Record<string, unknown>, version: string) {
  return apiFetch<Row>(`${apiPath}/${id}`, { method: 'PATCH', body: JSON.stringify(payload), headers: { 'If-Match': version } })
}

export function setMasterActive<Row extends MasterRow>(apiPath: string, id: string, active: boolean) {
  return apiFetch<Row>(`${apiPath}/${id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST', body: JSON.stringify({}) })
}

export async function deleteMaster(apiPath: string, id: string) {
  await apiFetch<undefined>(`${apiPath}/${id}`, { method: 'DELETE' })
}

export function restoreMaster<Row extends MasterRow>(apiPath: string, id: string) {
  return apiFetch<Row>(`${apiPath}/${id}/restore`, { method: 'POST', body: JSON.stringify({}) })
}
