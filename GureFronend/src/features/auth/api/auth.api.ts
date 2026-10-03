import { apiFetch } from '../../../lib/api'
import type { AuthAdmin } from '../authStore'
import { authStore } from '../authStore'

type LoginResponse = { accessToken: string; expiresIn: number; admin: AuthAdmin }
type OtpRequestResponse = { sent: boolean; devCode: string | null; expiresInSeconds: number }
type OtpLogEntry = { id: string; code: string; status: string; attempts: number; expiresAt: string; verifiedAt: string | null; createdAt: string }
type MeResponse = AuthAdmin & {
  roles: { code: string; name: string }[]
  permissions: string[]
  profile: { displayName: string; timezone: string; theme: string; avatarUrl: string | null }
}

export async function loginWithPassword(email: string, password: string, rememberMe: boolean) {
  const data = await apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, rememberMe }),
  })
  authStore.setSession(data.accessToken, data.admin)
  return data
}

export function requestOtp(phone: string) {
  return apiFetch<OtpRequestResponse>('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) })
}

export async function verifyOtp(phone: string, code: string, rememberMe: boolean) {
  const data = await apiFetch<LoginResponse>('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code, rememberMe }),
  })
  authStore.setSession(data.accessToken, data.admin)
  return data
}

export function fetchOtpLogs(phone: string) {
  return apiFetch<OtpLogEntry[]>(`/auth/otp/logs?phone=${encodeURIComponent(phone)}`)
}

export function forgotPassword(email: string) {
  return apiFetch<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
}

export function validateResetToken(token: string) {
  return apiFetch<{ purpose: 'reset' | 'invite' }>(`/auth/reset-password/validate?token=${encodeURIComponent(token)}`)
}

export function resetPassword(token: string, newPassword: string) {
  return apiFetch<{ success: boolean }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  })
}

export type AdminSession = {
  id: string
  deviceLabel: string | null
  ipAddress: string | null
  lastUsedAt: string
  createdAt: string
  isCurrent: boolean
}

export function fetchSessions() {
  return apiFetch<AdminSession[]>('/auth/sessions')
}

export async function revokeSession(id: string) {
  await apiFetch<undefined>(`/auth/sessions/${id}`, { method: 'DELETE' })
}

export function fetchMe() {
  return apiFetch<MeResponse>('/auth/me')
}

export async function logout() {
  await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined)
  authStore.clear()
}
