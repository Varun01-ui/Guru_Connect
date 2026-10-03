import { env } from '../../config/env.js'
import { sendMail } from '../../lib/mailer.js'

const portal = (path: string) => `${env.ADMIN_PORTAL_URL.replace(/\/$/, '')}${path}`

export function sendPasswordResetEmail(to: string, token: string) {
  return sendMail({
    to,
    subject: 'Reset your GuruConnect admin password',
    text: [
      'We received a request to reset your GuruConnect admin password.',
      '',
      `Reset it here (valid for 30 minutes, single use): ${portal(`/reset-password?token=${token}`)}`,
      '',
      "If you didn't ask for this, you can ignore this email — your password stays the same.",
    ].join('\n'),
  })
}

export function sendInviteEmail(to: string, token: string) {
  return sendMail({
    to,
    subject: 'You have been invited to the GuruConnect admin portal',
    text: `Set your password here (valid for 72 hours, single use): ${portal(`/accept-invite?token=${token}`)}`,
  })
}

export function sendPasswordChangedEmail(to: string) {
  return sendMail({
    to,
    subject: 'Your GuruConnect admin password was changed',
    text: [
      'Your admin password was just changed and you were signed out of every device.',
      "If this wasn't you, contact the Super Admin immediately.",
    ].join('\n'),
  })
}

export function sendAccountLockedEmail(to: string, lockedUntil: Date) {
  return sendMail({
    to,
    subject: 'Someone tried to sign in to your GuruConnect admin account',
    text: [
      'There were 5 failed sign-in attempts on your admin account, so it has been locked.',
      `It unlocks automatically at ${lockedUntil.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}, or sooner if you reset your password.`,
      "If this wasn't you, reset your password and tell the Super Admin.",
    ].join('\n'),
  })
}

export function sendTokenReuseEmail(to: string) {
  return sendMail({
    to,
    subject: 'GuruConnect admin: you were signed out for your security',
    text: [
      'We detected a sign-in session being reused after it had already been refreshed, which can mean the session was copied.',
      'We signed you out of every device. Sign in again, and change your password if you did not expect this.',
    ].join('\n'),
  })
}
