import type { Setting, SettingGroup } from './api/settings.api'

const base = { isPublic: true, isEditable: true, description: null, updatedBy: null, updatedAt: '2026-10-01T10:00:00.000Z' }

export const supportEmail: Setting = { ...base, key: 'contact.support_email', group: 'contact', label: 'Support email', valueType: 'email', value: 'support@guruconnect.in', description: 'Where users send support requests', updatedBy: { id: 'a1', name: 'Sameer Bhaiya' } }
export const supportPhone: Setting = { ...base, key: 'contact.support_phone', group: 'contact', label: 'Support phone', valueType: 'phone', value: '+918047182200', updatedAt: '2026-10-02T10:00:00.000Z' }
export const termsUrl: Setting = { ...base, key: 'legal.terms_url', group: 'legal', label: 'Terms & conditions URL', valueType: 'url', value: 'https://guruconnect.in/terms' }
export const platformName: Setting = { ...base, key: 'platform.name', group: 'general', label: 'Platform name', valueType: 'string', value: 'GuruConnect' }
export const redirects: Setting = { ...base, key: 'seo.redirects', group: 'general', label: 'Blog redirects', valueType: 'json', value: {}, isEditable: false, isPublic: false }
export const androidMin: Setting = { ...base, key: 'app.android_min_version', group: 'app_versions', label: 'Minimum Android version', valueType: 'semver', value: '1.0.0' }
export const androidLatest: Setting = { ...base, key: 'app.android_latest_version', group: 'app_versions', label: 'Latest Android version', valueType: 'semver', value: '1.2.0', updatedAt: '2026-10-03T10:00:00.000Z' }
export const maintenance: Setting = { ...base, key: 'app.maintenance_mode', group: 'app_versions', label: 'Maintenance mode', valueType: 'boolean', value: false, description: 'Shows a maintenance screen in the app' }
export const maxChildren: Setting = { ...base, key: 'limits.parent_max_children', group: 'limits', label: 'Max children per parent', valueType: 'number', value: 3, constraints: { min: 1, max: 5 } }
export const domains: Setting = { ...base, key: 'banners.allowed_domains', group: 'limits', label: 'Allowed banner link domains', valueType: 'json', value: ['guruconnect.in'], isPublic: false }

export const groups = (overrides: Partial<Record<string, Setting[]>> = {}): SettingGroup[] => [
  { group: 'general', settings: overrides.general ?? [platformName, redirects] },
  { group: 'contact', settings: overrides.contact ?? [supportEmail, supportPhone] },
  { group: 'legal', settings: overrides.legal ?? [termsUrl] },
  { group: 'app_versions', settings: overrides.app_versions ?? [androidLatest, androidMin, maintenance] },
  { group: 'limits', settings: overrides.limits ?? [domains, maxChildren] },
]
