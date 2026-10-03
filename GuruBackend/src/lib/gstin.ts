// GSTIN rules for institute registration (M21 BR-21.4). Shared by registration and the basics PATCH.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

// states.code (ISO 3166-2:IN suffix, plus the older aliases still seen in data) -> two-digit GST state code.
export const GST_STATE_CODES: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11',
  AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OD: '21', OR: '21', CG: '22',
  CT: '22', MP: '23', GJ: '24', DD: '25', DN: '26', DH: '26', MH: '27', KA: '29', GA: '30', LD: '31', KL: '32', TN: '33',
  PY: '34', PU: '34', AN: '35', TG: '36', TS: '36', AP: '37', LA: '38',
}

// Trim, drop spaces, upper-case. Empty means "no GSTIN" (stored as NULL).
export function normaliseGstin(value: string | null | undefined): string | null {
  const v = (value ?? '').replace(/\s+/g, '').toUpperCase()
  return v === '' ? null : v
}

export function gstinChecksumValid(gstin: string): boolean {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(gstin[i]!)
    if (v < 0) return false
    const p = v * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36] === gstin[14]
}

export type GstinCheck = { ok: true } | { ok: false; reason: 'format' | 'checksum' | 'state' }

// `stateCode` is states.code of the chosen city's state; when it has no known GST code the state check is skipped.
export function isValidGstin(gstin: string, stateCode?: string | null): GstinCheck {
  if (!PATTERN.test(gstin)) return { ok: false, reason: 'format' }
  if (!gstinChecksumValid(gstin)) return { ok: false, reason: 'checksum' }
  const expected = stateCode ? GST_STATE_CODES[stateCode.toUpperCase()] : undefined
  if (expected && gstin.slice(0, 2) !== expected) return { ok: false, reason: 'state' }
  return { ok: true }
}

export const GSTIN_MESSAGES = {
  format: 'Enter a valid 15-character GSTIN.',
  checksum: "This GSTIN doesn't look right. Check the last character.",
  state: 'This GSTIN is registered in another state.',
} as const

// Audit logs keep only the last four characters.
export const maskGstin = (gstin: string | null) => (gstin ? `${'X'.repeat(Math.max(0, gstin.length - 4))}${gstin.slice(-4)}` : null)
