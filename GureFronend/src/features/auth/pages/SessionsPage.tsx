import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../../lib/api'
import { fetchSessions, revokeSession } from '../api/auth.api'
import { SessionRow } from '../components/SessionRow'

const SESSIONS_KEY = ['auth', 'sessions'] as const

export function SessionsPage() {
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: fetchSessions })

  const revoke = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await revokeSession(id)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
  })

  const others = (sessions.data ?? []).filter((s) => !s.isCurrent)

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Account security</h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Where you're signed in. Sign out any device you don't recognise, then change your password.
      </p>

      <section className="mt-6 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <h2 className="text-sm font-semibold">Active sessions</h2>
          <button
            className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={others.length === 0 || revoke.isPending}
            onClick={() => revoke.mutate(others.map((s) => s.id))}
          >
            {revoke.isPending ? 'Signing out…' : 'Sign out other devices'}
          </button>
        </div>

        {sessions.isPending ? (
          <p className="border-t border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-fg-muted)]">Loading sessions…</p>
        ) : sessions.isError ? (
          <div role="alert" className="border-t border-[var(--color-border)] px-4 py-6 text-sm">
            <p className="text-[var(--color-bad)]">
              {sessions.error instanceof ApiError ? sessions.error.message : 'Could not load your sessions.'}
            </p>
            <button className="mt-3 font-medium text-[var(--color-accent)] hover:underline" type="button" onClick={() => sessions.refetch()}>
              Try again
            </button>
          </div>
        ) : sessions.data.length === 0 ? (
          <p className="border-t border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-fg-muted)]">No active sessions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Device</th>
                  <th className="px-4 py-2.5 font-semibold">IP address</th>
                  <th className="px-4 py-2.5 font-semibold">Last active</th>
                  <th className="px-4 py-2.5 font-semibold">Signed in</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {sessions.data.map((session) => (
                  <SessionRow key={session.id} session={session} busy={revoke.isPending} onRevoke={(id) => revoke.mutate([id])} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {revoke.isError ? (
          <p role="alert" className="border-t border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-bad)]">
            {revoke.error instanceof ApiError ? revoke.error.message : 'Could not sign out that device.'}
          </p>
        ) : null}
      </section>
    </div>
  )
}
