import type { Setting } from './api/settings.api'

// Mirrors the server's per-type rules (M04 FR-4.2) so a mistake shows next to the input before anything is sent.
// The server stays the authority and has the final say, including the per-key rules for json values.
export function validateSettingValue(setting: Pick<Setting, 'valueType' | 'constraints'>, value: unknown): string | null {
  switch (setting.valueType) {
    case 'string': {
      const text = typeof value === 'string' ? value.trim() : ''
      return text.length >= 1 && text.length <= 200 ? null : 'Enter 1–200 characters.'
    }
    case 'number': {
      const { min, max } = setting.constraints ?? { min: 0, max: 1_000_000 }
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'Enter a whole number.'
      return value >= min && value <= max ? null : `Enter a number from ${min} to ${max}.`
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Choose on or off.'
    case 'url':
      try {
        return typeof value === 'string' && new URL(value.trim()).protocol === 'https:' ? null : 'Enter a link starting with https://'
      } catch {
        return 'Enter a link starting with https://'
      }
    case 'email':
      return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'Enter a valid email address.'
    case 'phone':
      return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value.trim()) ? null : 'Enter a phone number like +919876543210.'
    case 'semver':
      return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim()) ? null : 'Enter a version like 1.2.0'
    case 'json':
      return value === undefined ? 'Enter valid JSON.' : null
  }
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const GROUP_LABELS: Record<string, string> = {
  general: 'General',
  contact: 'Contact',
  legal: 'Legal',
  app_versions: 'App versions',
  limits: 'Limits',
}
export const groupLabel = (group: string) => GROUP_LABELS[group] ?? group.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export const MAINTENANCE_KEY = 'app.maintenance_mode'
export const needsReason = (key: string) => key.startsWith('app.')
