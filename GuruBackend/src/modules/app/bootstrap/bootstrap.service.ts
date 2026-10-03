import * as repo from './bootstrap.repository.js'

export async function buildBootstrap() {
  const s = await repo.getPublicSettingsMap()
  const emailEnabled = await repo.getSettingByKey('auth.email_login_enabled')
  const googleEnabled = await repo.getSettingByKey('auth.google_login_enabled')
  const otpResend = await repo.getSettingByKey('auth.otp_resend_after_seconds')

  return {
    serverTime: new Date().toISOString(),
    app: {
      minVersion: String(s['app.android_min_version'] ?? '1.0.0'),
      latestVersion: String(s['app.android_latest_version'] ?? '1.0.0'),
      updateRequired: false,
      updateAvailable: false,
      updateMessage: String(s['app.update_message'] ?? ''),
      storeUrl: String(s['app.store_url_android'] ?? ''),
    },
    maintenance: {
      enabled: Boolean(s['app.maintenance_mode'] ?? false),
      message: (s['app.maintenance_message'] as string) ?? null,
      endsAt: (s['app.maintenance_ends_at'] as string) ?? null,
    },
    onboardingVersion: Number(s['app.onboarding_version'] ?? 1),
    auth: {
      phoneOtp: true,
      email: Boolean(emailEnabled ?? true),
      google: Boolean(googleEnabled ?? true),
      otpResendAfterSeconds: Number(otpResend ?? 30),
    },
    support: {
      email: String(s['support.email'] ?? 'support@guruconnect.in'),
      phone: String(s['support.phone'] ?? ''),
      whatsapp: String(s['support.whatsapp_number'] ?? ''),
    },
    legal: {
      termsUrl: String(s['legal.terms_url'] ?? ''),
      privacyUrl: String(s['legal.privacy_url'] ?? ''),
      refundUrl: String(s['legal.refund_url'] ?? ''),
    },
    limits: {
      parentMaxChildren: Number(s['limits.parent_max_children'] ?? 3),
      reviewMinChars: Number(s['reviews.review_min_chars'] ?? 30),
      studentMinAgeWithoutConsent: Number(s['students.min_age_without_consent'] ?? 18),
    },
    features: {},
    mastersVersion: '1',
  }
}
