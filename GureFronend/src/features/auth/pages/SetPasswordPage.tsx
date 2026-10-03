import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../../../lib/api'
import { IconShieldCheck } from '../../../components/icons'
import { resetPassword, validateResetToken } from '../api/auth.api'
import { PasswordStrength } from '../components/PasswordStrength'
import { isPasswordAcceptable } from '../passwordPolicy'

type Status = 'checking' | 'valid' | 'invalid' | 'done'
type Mode = 'reset' | 'invite'

const inputClass =
  'h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-4 focus:ring-[var(--color-accent-soft)]'
const labelClass = 'flex flex-col gap-1.5 text-sm font-medium text-[var(--color-fg-muted)]'
const primaryButtonClass =
  'h-11 rounded-lg bg-[var(--color-accent)] text-sm font-semibold text-white shadow-sm transition-all hover:bg-[var(--color-accent-hover)] hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100'

const COPY = {
  reset: {
    title: 'Reset password',
    submit: 'Set new password',
    saving: 'Saving…',
    passwordLabel: 'New password',
    confirmLabel: 'Confirm new password',
    done: "Your password has been changed. You've been signed out everywhere else.",
  },
  invite: {
    title: 'Set your password',
    submit: 'Set password & activate',
    saving: 'Activating…',
    passwordLabel: 'Password',
    confirmLabel: 'Confirm password',
    done: 'Your account is ready. Sign in with your new password.',
  },
} satisfies Record<Mode, Record<string, string>>

function messagesFrom(err: unknown): string[] {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length > 0) {
      return (err.details as { message?: string }[]).map((d) => d.message).filter((m): m is string => !!m)
    }
    return [err.message]
  }
  return ['Something went wrong. Please try again.']
}

// One form for both "reset password" (emailed link) and "accept invite" (M02 invite link): the token endpoints
// are the same, only the wording differs.
export function SetPasswordPage({ mode }: { mode: Mode }) {
  const copy = COPY[mode]
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<Status>(token ? 'checking' : 'invalid')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) return
    validateResetToken(token)
      .then(() => setStatus('valid'))
      .catch(() => setStatus('invalid'))
  }, [token])

  const mismatch = confirm.length > 0 && password !== confirm

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErrors([])
    if (password !== confirm) {
      setErrors(["Passwords don't match."])
      return
    }
    setBusy(true)
    try {
      await resetPassword(token, password)
      setStatus('done')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_LINK_EXPIRED') setStatus('invalid')
      else setErrors(messagesFrom(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm animate-[fade-in-up_0.5s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-lg)]">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(145deg,#6d67ff,#4338ca)] text-white">
          <IconShieldCheck className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">{copy.title}</h1>

        {status === 'checking' && <p className="mt-3 text-sm text-[var(--color-fg-muted)]">Checking your link…</p>}

        {status === 'invalid' && (
          <div className="animate-[fade-in_0.25s_ease-out]">
            <p className="mt-3 text-sm">This link has expired. Request a new one.</p>
            <Link className="mt-5 block text-center text-sm font-medium text-[var(--color-accent)] hover:underline" to="/forgot-password">
              Request a new link
            </Link>
          </div>
        )}

        {status === 'done' && (
          <div className="animate-[fade-in_0.25s_ease-out]">
            <p className="mt-3 text-sm">{copy.done}</p>
            <Link className="mt-5 block text-center text-sm font-medium text-[var(--color-accent)] hover:underline" to="/login">
              Sign in
            </Link>
          </div>
        )}

        {status === 'valid' && (
          <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit}>
            <label className={labelClass}>
              {copy.passwordLabel}
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <PasswordStrength password={password} />
            <label className={labelClass}>
              {copy.confirmLabel}
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>
            {mismatch ? <p className="-mt-2 text-xs text-[var(--color-bad)]">Passwords don't match.</p> : null}
            {errors.length > 0 ? (
              <ul role="alert" className="rounded-lg border border-[var(--color-bad)]/20 bg-[var(--color-bad-soft)] px-3 py-2 text-sm text-[var(--color-bad)]">
                {errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
            <button className={primaryButtonClass} type="submit" disabled={busy || !isPasswordAcceptable(password) || password !== confirm}>
              {busy ? copy.saving : copy.submit}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
