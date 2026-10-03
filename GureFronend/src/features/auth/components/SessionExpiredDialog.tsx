import { useLocation, useNavigate } from 'react-router-dom'
import { authStore } from '../authStore'

// Shown over the current page when the session can no longer be refreshed mid-work. Signing in again returns to
// the same route (LoginPage reads location.state.from).
export function SessionExpiredDialog() {
  const navigate = useNavigate()
  const location = useLocation()

  function signInAgain() {
    authStore.clear()
    navigate('/login', { state: { from: location }, replace: true })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
        className="w-full max-w-sm animate-[fade-in-up_0.3s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-lg)]"
      >
        <h2 id="session-expired-title" className="text-lg font-semibold">
          Your session ended
        </h2>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">Sign in again to keep working. You'll come back to this page.</p>
        <button
          className="mt-5 h-11 w-full rounded-lg bg-[var(--color-accent)] text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)]"
          type="button"
          autoFocus
          onClick={signInAgain}
        >
          Sign in again
        </button>
      </div>
    </div>
  )
}
