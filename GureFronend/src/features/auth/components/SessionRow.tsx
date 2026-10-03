import type { AdminSession } from '../api/auth.api'

const dateFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

function formatWhen(iso: string): string {
  return dateFormat.format(new Date(iso))
}

export function SessionRow({ session, onRevoke, busy }: { session: AdminSession; onRevoke: (id: string) => void; busy: boolean }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-2 font-medium">
          {session.deviceLabel ?? 'Unknown device'}
          {session.isCurrent ? (
            <span className="rounded-full bg-[var(--color-good-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-good)]">This device</span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3.5 font-[var(--font-mono)] text-[13px] text-[var(--color-fg-muted)]">{session.ipAddress ?? '—'}</td>
      <td className="px-4 py-3.5 text-[var(--color-fg-muted)]">{formatWhen(session.lastUsedAt)}</td>
      <td className="px-4 py-3.5 text-[var(--color-fg-muted)]">{formatWhen(session.createdAt)}</td>
      <td className="px-4 py-3.5 text-right">
        {session.isCurrent ? null : (
          <button
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-bad)]/40 hover:text-[var(--color-bad)] disabled:opacity-50"
            type="button"
            disabled={busy}
            onClick={() => onRevoke(session.id)}
            aria-label={`Sign out ${session.deviceLabel ?? 'unknown device'}`}
          >
            Sign out
          </button>
        )}
      </td>
    </tr>
  )
}
