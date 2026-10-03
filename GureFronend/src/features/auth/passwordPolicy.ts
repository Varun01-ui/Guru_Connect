export type PasswordCheck = { id: string; label: string; ok: boolean }

export type Identity = { email?: string; fullName?: string }

// Mirrors the server's policy (FR-1.10) so the checklist and the API agree. The server stays the authority:
// it also rejects common passwords and a password equal to the email/name.
export function passwordChecks(password: string, ctx: Identity = {}): PasswordCheck[] {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  const lower = password.toLowerCase()
  const checks: PasswordCheck[] = [
    { id: 'length', label: 'At least 12 characters', ok: password.length >= 12 },
    { id: 'classes', label: '3 of: lowercase, uppercase, digit, symbol', ok: classes >= 3 },
  ]
  if (ctx.email || ctx.fullName) {
    const sameAsEmail = !!ctx.email && (lower === ctx.email.toLowerCase() || lower === ctx.email.split('@')[0]?.toLowerCase())
    const sameAsName = !!ctx.fullName && lower === ctx.fullName.trim().toLowerCase()
    checks.push({ id: 'identity', label: 'Not your email or name', ok: password.length > 0 && !sameAsEmail && !sameAsName })
  }
  return checks
}

export function isPasswordAcceptable(password: string, ctx?: Identity): boolean {
  return password.length <= 128 && passwordChecks(password, ctx).every((c) => c.ok)
}
