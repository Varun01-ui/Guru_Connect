import { apiFetch } from '../../../lib/api'

export type NotificationPrefs = { email_digest: boolean; queue_alerts: boolean; security_alerts: boolean }

export type Profile = {
  id: string
  email: string
  fullName: string
  displayName: string | null
  designation: string | null
  phone: string | null
  avatar: { fileId: string; url: string | null } | null
  timezone: string
  locale: 'en-IN' | 'hi-IN'
  theme: 'light' | 'dark' | 'system'
  notificationPrefs: NotificationPrefs
  roles: string[]
  lastLoginAt: string | null
  updatedAt: string
}

export type ProfilePatch = Partial<{
  fullName: string
  displayName: string | null
  designation: string | null
  phone: string | null
  timezone: string
  locale: 'en-IN' | 'hi-IN'
  theme: 'light' | 'dark' | 'system'
  notificationPrefs: Partial<Pick<NotificationPrefs, 'email_digest' | 'queue_alerts'>>
}>

export const fetchProfile = () => apiFetch<Profile>('/me/profile')

// If-Match is the profile's updatedAt as read; a profile changed in another tab answers 409 VERSION_CONFLICT.
export const patchProfile = (body: ProfilePatch, version: string) =>
  apiFetch<Profile>('/me/profile', { method: 'PATCH', body: JSON.stringify(body), headers: { 'If-Match': version } })

export const setAvatar = (fileId: string) => apiFetch<Profile>('/me/profile/avatar', { method: 'PUT', body: JSON.stringify({ fileId }) })

export const removeAvatar = () => apiFetch<Profile>('/me/profile/avatar', { method: 'DELETE' })

export const changePassword = (body: { currentPassword: string; newPassword: string; signOutOtherSessions: boolean }) =>
  apiFetch<{ accessToken: string; expiresIn: number; sessionsRevoked: number }>('/me/change-password', { method: 'POST', body: JSON.stringify(body) })
