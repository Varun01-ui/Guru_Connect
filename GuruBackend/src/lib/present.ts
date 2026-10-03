import { env } from '../config/env.js'

export function cdnUrl(objectKey: string | null | undefined): string | null {
  return objectKey ? `${env.CDN_BASE_URL.replace(/\/$/, '')}/${objectKey.replace(/^\//, '')}` : null
}

// +919845014210 -> "+91 98450 XXXXX" (country code and first 5 digits stay, the rest is masked).
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const match = phone.match(/^\+(\d{1,3}?)(\d{10})$/)
  if (!match) return phone.length > 4 ? `${phone.slice(0, 3)} ${'X'.repeat(phone.length - 3)}` : phone
  return `+${match[1]} ${match[2]!.slice(0, 5)} XXXXX`
}

// lakshmi@gmail.com -> "l***i@gmail.com"
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 1) return null
  const local = email.slice(0, at)
  const masked = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`
  return `${masked}${email.slice(at)}`
}
