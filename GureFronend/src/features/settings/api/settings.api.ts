import { apiFetch } from '../../../lib/api'

export type SettingValueType = 'string' | 'number' | 'boolean' | 'url' | 'email' | 'phone' | 'semver' | 'json'

export type Setting = {
  key: string
  group: string
  label: string
  valueType: SettingValueType
  value: unknown
  description: string | null
  isPublic: boolean
  isEditable: boolean
  updatedAt: string
  updatedBy: { id: string; name: string } | null
  constraints?: { min: number; max: number }
}
export type SettingGroup = { group: string; settings: Setting[] }

export type SettingHistoryEntry = {
  id: string
  action: string
  actorEmail: string | null
  oldValue: unknown
  newValue: unknown
  reason: string | null
  at: string
}

export const fetchSettings = () => apiFetch<{ groups: SettingGroup[] }>('/settings')

export const fetchSetting = (key: string) => apiFetch<Setting & { history: SettingHistoryEntry[] }>(`/settings/${encodeURIComponent(key)}`)

// `version` is the newest updatedAt among the submitted keys; a stale form answers 409 VERSION_CONFLICT.
export const saveSettings = (body: { group: string; values: Record<string, unknown>; reason?: string; confirmMaintenance?: boolean }, version: string) =>
  apiFetch<{ updated: number; group: SettingGroup }>('/settings', { method: 'PATCH', body: JSON.stringify(body), headers: { 'If-Match': version } })
