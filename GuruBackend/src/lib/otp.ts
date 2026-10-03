import { createHmac, randomInt } from 'node:crypto'
import { env } from '../config/env.js'

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

// The login screen takes a bare 10-digit number; admin_profiles.phone is stored as +91XXXXXXXXXX.
export function toIndianE164(phone: string): string {
  return phone.length === 10 ? `+91${phone}` : phone
}

// Mobile app OTP challenges (otp_challenges.code_hash) store only an HMAC, never the code itself —
// unlike the admin flow above, there's a real (if console-only) delivery channel for these codes.
export function hashOtpCode(code: string): string {
  return createHmac('sha256', env.OTP_PEPPER).update(code).digest('hex')
}

export function otpCodeMatches(code: string, hash: string): boolean {
  return hashOtpCode(code) === hash
}
