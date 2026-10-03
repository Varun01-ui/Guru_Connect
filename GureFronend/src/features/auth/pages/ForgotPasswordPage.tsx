import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IconShieldCheck } from '../../../components/icons'
import { forgotPassword } from '../api/auth.api'

const inputClass =
  'h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-4 focus:ring-[var(--color-accent-soft)]'
const labelClass = 'flex flex-col gap-1.5 text-sm font-medium text-[var(--color-fg-muted)]'
const primaryButtonClass =
  'h-11 rounded-lg bg-[var(--color-accent)] text-sm font-semibold text-white shadow-sm transition-all hover:bg-[var(--color-accent-hover)] hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await forgotPassword(email)
    } finally {
      setBusy(false)
      setSent(true)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm animate-[fade-in-up_0.5s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-lg)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(145deg,#6d67ff,#4338ca)] text-white">
          <IconShieldCheck className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">Forgot password</h1>
        {sent ? (
          <div className="animate-[fade-in_0.25s_ease-out]">
            <p className="mt-3 text-sm">If an account exists for that email, we've emailed a reset link.</p>
            <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
              No email service is configured in this environment yet — check the backend server's console output for the
              reset link.
            </p>
            <Link className="mt-5 block text-center text-sm font-medium text-[var(--color-accent)] hover:underline" to="/login">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit}>
            <label className={labelClass}>
              Email
              <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <button className={primaryButtonClass} type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <Link className="text-center text-sm font-medium text-[var(--color-accent)] hover:underline" to="/login">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  )
}
