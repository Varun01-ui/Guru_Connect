import { apiFetch, apiFetchPage } from '../../../lib/api'
import type { PageMeta } from '../../../lib/api'

export type PermissionGroup = { module: string; permissions: { key: string; description: string; isSensitive: boolean }[] }

export type RoleSummary = {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  permissionCount: number
  adminCount: number
  updatedAt: string
}
export type RoleDetail = {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  permissionKeys: string[]
  admins: { id: string; fullName: string; email: string }[]
  updatedAt: string
}
export type RoleRef = { id: string; code: string; name: string }

export type AdminStatus = 'active' | 'invited' | 'locked' | 'disabled'
export type AdminRow = {
  id: string
  email: string
  fullName: string
  status: AdminStatus
  isSuperAdmin: boolean
  roles: RoleRef[]
  lastLoginAt: string | null
  createdAt: string
}
export type AdminDetail = AdminRow & { sessionsCount: number; updatedAt: string; inviteExpiresAt?: string }

export type AdminListParams = {
  page: number
  pageSize: number
  q?: string
  status?: AdminStatus
  roleId?: string
  lastLogin?: 'never' | 'stale30'
}

export const fetchPermissionCatalogue = () => apiFetch<PermissionGroup[]>('/permissions')
export const fetchRoles = () => apiFetch<RoleSummary[]>('/roles')
export const fetchRole = (id: string) => apiFetch<RoleDetail>(`/roles/${id}`)

export const createRole = (body: { name: string; description: string | null; permissionKeys: string[]; reason?: string }) =>
  apiFetch<RoleDetail>('/roles', { method: 'POST', body: JSON.stringify(body) })

export const patchRole = (id: string, body: { name?: string; description?: string | null }, version: string) =>
  apiFetch<RoleDetail>(`/roles/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'If-Match': version } })

// If-Match is the role's updatedAt as read; a stale matrix answers 409 VERSION_CONFLICT with the current role.
export const putRolePermissions = (id: string, permissionKeys: string[], version: string, reason?: string) =>
  apiFetch<RoleDetail>(`/roles/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissionKeys, ...(reason ? { reason } : {}) }), headers: { 'If-Match': version } })

export const deleteRole = (id: string) => apiFetch<undefined>(`/roles/${id}`, { method: 'DELETE' })

export function fetchAdmins(params: AdminListParams): Promise<{ data: AdminRow[]; meta: PageMeta }> {
  const qs = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.q) qs.set('q', params.q)
  if (params.status) qs.set('status', params.status)
  if (params.roleId) qs.set('roleId', params.roleId)
  if (params.lastLogin) qs.set('lastLogin', params.lastLogin)
  return apiFetchPage<AdminRow[]>(`/admins?${qs}`)
}
export const fetchAdmin = (id: string) => apiFetch<AdminDetail>(`/admins/${id}`)

export const inviteAdmin = (body: { email: string; fullName: string; roleIds: string[]; reason?: string }) =>
  apiFetch<{ id: string; email: string; status: 'invited'; roles: { code: string }[]; inviteExpiresAt: string }>('/admins/invite', { method: 'POST', body: JSON.stringify(body) })

export const patchAdmin = (id: string, fullName: string, version: string) =>
  apiFetch<AdminDetail>(`/admins/${id}`, { method: 'PATCH', body: JSON.stringify({ fullName }), headers: { 'If-Match': version } })

export const putAdminRoles = (id: string, roleIds: string[], reason?: string) =>
  apiFetch<AdminDetail>(`/admins/${id}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds, ...(reason ? { reason } : {}) }) })

export const resendInvite = (id: string) => apiFetch<{ id: string; email: string; status: 'invited'; inviteExpiresAt: string }>(`/admins/${id}/resend-invite`, { method: 'POST' })
export const disableAdmin = (id: string, reason: string) => apiFetch<AdminDetail>(`/admins/${id}/disable`, { method: 'POST', body: JSON.stringify({ reason }) })
export const enableAdmin = (id: string) => apiFetch<AdminDetail>(`/admins/${id}/enable`, { method: 'POST' })
export const deleteAdmin = (id: string, reason: string) => apiFetch<undefined>(`/admins/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) })
export const revokeAllSessions = (id: string) => apiFetch<unknown>(`/admins/${id}/sessions`, { method: 'DELETE' })
