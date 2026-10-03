import { passwordChecks } from '../passwordPolicy'
import type { Identity } from '../passwordPolicy'

export function PasswordStrength({ password, email, fullName }: { password: string } & Identity) {
  const checks = passwordChecks(password, { email, fullName })
  return (
    <ul className="flex flex-col gap-1 text-xs" aria-label="Password requirements">
      {checks.map((check) => (
        <li
          key={check.id}
          data-ok={check.ok}
          className={`flex items-center gap-2 ${check.ok ? 'text-[var(--color-good)]' : 'text-[var(--color-fg-muted)]'}`}
        >
          <span aria-hidden className="w-3 text-center">
            {check.ok ? '✓' : '○'}
          </span>
          <span>{check.label}</span>
          <span className="sr-only">{check.ok ? '(met)' : '(not met yet)'}</span>
        </li>
      ))}
    </ul>
  )
}
