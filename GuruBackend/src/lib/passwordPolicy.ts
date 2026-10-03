// FR-1.10 password policy. Returned as field-level messages so the UI checklist and the API agree.
// Not implemented (see modules/M01 §21): breached-password lookup (HIBP) and password history.
const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'password123456',
  'qwerty123456',
  'qwertyuiop12',
  'letmein12345',
  'welcome12345',
  'admin1234567',
  'administrator',
  'iloveyou1234',
  '123456789012',
  'guruconnect123',
  'guruconnect@123',
])

export type PasswordContext = { email?: string | null; fullName?: string | null }

export function passwordPolicyIssues(password: string, ctx: PasswordContext = {}): string[] {
  const issues: string[] = []
  if (password.length < 12) issues.push('Use at least 12 characters.')
  if (password.length > 128) issues.push('Use at most 128 characters.')

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  if (classes < 3) issues.push('Use at least 3 of: lowercase, uppercase, digit, symbol.')

  const lower = password.toLowerCase()
  if (ctx.email && (lower === ctx.email.toLowerCase() || lower === ctx.email.split('@')[0]!.toLowerCase())) {
    issues.push("Password can't be your email.")
  }
  if (ctx.fullName && lower === ctx.fullName.trim().toLowerCase()) issues.push("Password can't be your name.")
  if (COMMON_PASSWORDS.has(lower)) issues.push('That password is too common.')
  return issues
}
