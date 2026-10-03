import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../../../lib/api'
import { IconLock, IconPhone, IconShieldCheck, IconSparkles } from '../../../components/icons'
import { fetchOtpLogs, loginWithPassword, requestOtp, verifyOtp } from '../api/auth.api'

type Tab = 'password' | 'otp'

const inputClass =
  'h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-4 focus:ring-[var(--color-accent-soft)]'
const labelClass = 'flex flex-col gap-1.5 text-sm font-medium text-[var(--color-fg-muted)]'
const primaryButtonClass =
  'h-11 rounded-lg bg-[var(--color-accent)] text-sm font-semibold text-white shadow-sm transition-all hover:bg-[var(--color-accent-hover)] hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100'

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'AUTH_ACCOUNT_LOCKED') {
      const until = (err.details as { lockedUntil?: string } | undefined)?.lockedUntil
      const time = until ? new Date(until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : 'shortly'
      return `Too many attempts. Try again after ${time}.`
    }
    return err.message
  }
  return 'Something went wrong. Please try again.'
}

function lockedUntilOf(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'AUTH_ACCOUNT_LOCKED') return null
  const until = (err.details as { lockedUntil?: string } | undefined)?.lockedUntil
  return until ? new Date(until).getTime() : null
}

// Seconds left until `until` (epoch ms), ticking once a second; 0 when there is nothing to wait for.
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="animate-[fade-in_0.2s_ease-out] rounded-lg border border-[var(--color-bad)]/20 bg-[var(--color-bad-soft)] px-3 py-2 text-sm text-[var(--color-bad)]">
      {message}
    </p>
  )
}

export function LoginPage() {
  const [tab, setTab] = useState<Tab>('password')
  const navigate = useNavigate()
  const location = useLocation() as { state?: { from?: { pathname: string } } }
  const redirectTo = location.state?.from?.pathname ?? '/'

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="relative hidden overflow-hidden bg-[var(--color-navy)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,_#6d67ff_0%,_transparent_70%)] opacity-30 blur-3xl animate-[float-blob_12s_ease-in-out_infinite]"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-[radial-gradient(circle,_#4338ca_0%,_transparent_70%)] opacity-30 blur-3xl animate-[float-blob_14s_ease-in-out_infinite_1s]"
          aria-hidden
        />

        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(145deg,#6d67ff,#4338ca)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]">
            <IconShieldCheck className="h-5 w-5" />
          </span>
          <div className="leading-tight text-white">
            <div className="font-[var(--font-display)] text-lg font-semibold">GuruConnect</div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-navy-ink-muted)]">Admin Portal</div>
          </div>
        </div>

        <div className="relative animate-[fade-in-up_0.6s_ease-out] text-[var(--color-navy-ink)]">
          <h1 className="max-w-md font-[var(--font-display)] text-3xl font-semibold leading-tight text-white">
            Run the platform with confidence.
          </h1>
          <p className="mt-3 max-w-sm text-sm text-[var(--color-navy-ink-muted)]">
            Verify teachers and institutes, moderate reviews, track trust scores, and keep every payment and complaint
            under control — all from one place.
          </p>
          <ul className="mt-8 flex flex-col gap-3 text-sm">
            {['Every action is audited, end to end', 'Role-based access for your whole team', 'Built for the way GuruConnect actually runs'].map(
              (line, i) => (
                <li
                  key={line}
                  className="flex animate-[fade-in-up_0.6s_ease-out_backwards] items-center gap-2.5"
                  style={{ animationDelay: `${150 + i * 100}ms` }}
                >
                  <IconSparkles className="h-4 w-4 flex-none text-[var(--color-navy-ink-muted)]" />
                  {line}
                </li>
              ),
            )}
          </ul>
        </div>

        <p className="relative text-xs text-[var(--color-navy-ink-muted)]">© {new Date().getFullYear()} GuruConnect</p>
      </div>

      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-10">
        <div className="w-full max-w-sm animate-[fade-in-up_0.5s_ease-out] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-lg)]">
          <div className="mb-6 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(145deg,#6d67ff,#4338ca)] text-white">
              <IconShieldCheck className="h-5 w-5" />
            </span>
          </div>
          <h1 className="text-xl font-semibold">Welcome back</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Sign in to the GuruConnect admin portal</p>

          <div className="mt-6 inline-flex w-full rounded-lg bg-[var(--color-surface-2)] p-1">
            <button
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-all ${
                tab === 'password'
                  ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
              }`}
              onClick={() => setTab('password')}
              type="button"
            >
              Password
            </button>
            <button
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-all ${
                tab === 'otp'
                  ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
              }`}
              onClick={() => setTab('otp')}
              type="button"
            >
              Mobile OTP
            </button>
          </div>

          <div key={tab} className="mt-6 animate-[fade-in_0.25s_ease-out]">
            {tab === 'password' ? (
              <PasswordLoginForm onSuccess={() => navigate(redirectTo, { replace: true })} />
            ) : (
              <OtpLoginForm onSuccess={() => navigate(redirectTo, { replace: true })} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PasswordLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const secondsLocked = useCountdown(lockedUntil)
  const locked = secondsLocked > 0

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await loginWithPassword(email, password, rememberMe)
      onSuccess()
    } catch (err) {
      setLockedUntil(lockedUntilOf(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <label className={labelClass}>
        Email
        <input
          className={inputClass}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className={labelClass}>
        Password
        <input
          className={inputClass}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
          <input
            className="h-4 w-4 accent-[var(--color-accent)]"
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          Keep me signed in
        </label>
        <Link className="text-sm font-medium text-[var(--color-accent)] hover:underline" to="/forgot-password">
          Forgot password?
        </Link>
      </div>
      {locked ? (
        <p role="alert" className="rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">
          Account locked after too many attempts. Try again in <b className="font-[var(--font-mono)]">{formatCountdown(secondsLocked)}</b>, or{' '}
          <Link className="font-semibold underline" to="/forgot-password">
            reset your password
          </Link>
          .
        </p>
      ) : error ? (
        <ErrorBanner message={error} />
      ) : null}
      <button className={primaryButtonClass} type="submit" disabled={busy || locked}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

function OtpLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSend(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await requestOtp(phone)
      setSent(true)
      setDevCode(res.devCode)
      setCode('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await verifyOtp(phone, code, true)
      onSuccess()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function fillFromLogs() {
    setError(null)
    try {
      const logs = await fetchOtpLogs(phone)
      const latest = logs[0]
      if (latest) setCode(latest.code)
      else setError('No OTP has been sent to this number yet.')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (!sent) {
    return (
      <form className="flex flex-col gap-4" onSubmit={onSend}>
        <label className={labelClass}>
          Mobile number
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-3.5 transition-colors focus-within:border-[var(--color-accent)] focus-within:ring-4 focus-within:ring-[var(--color-accent-soft)]">
            <IconPhone className="h-4 w-4 flex-none text-[var(--color-fg-muted)]" />
            <input
              className="h-11 w-full bg-transparent pr-3.5 text-sm outline-none"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="9999999999"
              required
            />
          </div>
        </label>
        {error ? <ErrorBanner message={error} /> : null}
        <button className={primaryButtonClass} type="submit" disabled={busy || phone.length !== 10}>
          {busy ? 'Sending…' : 'Send code'}
        </button>
      </form>
    )
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onVerify}>
      <p className="text-sm text-[var(--color-fg-muted)]">
        Code sent to <b className="text-[var(--color-fg)]">{phone}</b>.
      </p>
      {devCode ? (
        <div className="flex animate-[fade-in-up_0.3s_ease-out] items-center gap-2.5 rounded-lg border border-dashed border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3 text-sm">
          <IconSparkles className="h-4 w-4 flex-none text-[var(--color-accent)]" />
          <span>
            No SMS gateway is configured yet — your development code is{' '}
            <b className="font-[var(--font-mono)] tracking-wider">{devCode}</b>.
          </span>
        </div>
      ) : null}
      <label className={labelClass}>
        6-digit code
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-3.5 transition-colors focus-within:border-[var(--color-accent)] focus-within:ring-4 focus-within:ring-[var(--color-accent-soft)]">
          <IconLock className="h-4 w-4 flex-none text-[var(--color-fg-muted)]" />
          <input
            className="h-11 w-full bg-transparent pr-3.5 font-[var(--font-mono)] text-sm tracking-[0.3em] outline-none"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </div>
      </label>
      <button
        className="self-start text-sm font-medium text-[var(--color-accent)] transition-opacity hover:underline"
        type="button"
        onClick={fillFromLogs}
      >
        Fill from OTP logs
      </button>
      {error ? <ErrorBanner message={error} /> : null}
      <button className={primaryButtonClass} type="submit" disabled={busy || code.length !== 6}>
        {busy ? 'Verifying…' : 'Verify & sign in'}
      </button>
      <button
        className="text-center text-sm text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
        type="button"
        onClick={() => setSent(false)}
      >
        Use a different number
      </button>
    </form>
  )
}
