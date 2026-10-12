import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { AvatarUploader } from '../components/AvatarUploader'
import { ChangePasswordDialog } from '../components/ChangePasswordDialog'
import { NotificationPrefs } from '../components/NotificationPrefs'
import { PreferencesForm } from '../components/PreferencesForm'
import { ProfileForm } from '../components/ProfileForm'
import { secondaryButton } from '../formUtils'
import { PROFILE_KEY, useProfile, useSaveProfile } from '../useProfile'
import type { ProfilePatch } from '../api/account.api'

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function AccountPage() {
  const queryClient = useQueryClient()
  const profile = useProfile()
  const save = useSaveProfile()
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordDone, setPasswordDone] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  // Bumped on "Reload latest" so the forms start again from the server's values.
  const [reloads, setReloads] = useState(0)

  if (profile.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading your account…</p>
  if (profile.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{profile.error instanceof ApiError ? profile.error.message : 'Could not load your account.'}</p>
        <button type="button" className="mt-3 font-medium text-[var(--color-accent)] hover:underline" onClick={() => profile.refetch()}>
          Try again
        </button>
      </div>
    )
  }

  const me = profile.data
  // Each section sends the version it last saw; the answer becomes the cached profile, so the next save is current.
  const onSave = (patch: ProfilePatch) => save.mutateAsync({ patch, version: me.updatedAt })
  const onConflict = () => setStale(true)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">My account</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {me.roles.length > 0 ? me.roles.join(', ') : 'No role assigned'}
          {me.lastLoginAt ? ` · last sign-in ${formatDateTime(me.lastLoginAt)}` : ''}
        </p>
      </div>

      {stale ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
          <span>Your profile changed in another tab. Reload.</span>
          <button
            type="button"
            className="rounded-lg border border-[var(--color-warn)]/40 px-3 py-1.5 font-semibold"
            onClick={() => {
              setStale(false)
              void profile.refetch().then(() => setReloads((n) => n + 1))
            }}
          >
            Reload latest
          </button>
        </div>
      ) : null}

      <Section title="Profile">
        <div className="mb-5">
          <AvatarUploader profile={me} onChanged={(next) => {
            queryClient.setQueryData(PROFILE_KEY, next)
            void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
          }} />
        </div>
        <ProfileForm key={`profile-${reloads}`} profile={me} busy={save.isPending} onSave={onSave} onConflict={onConflict} />
      </Section>

      <Section title="Preferences" description="How the portal looks and shows dates for you.">
        <PreferencesForm key={`prefs-${reloads}`} profile={me} busy={save.isPending} onSave={onSave} onConflict={onConflict} />
      </Section>

      <Section title="Notifications" description="Which emails you get.">
        <NotificationPrefs profile={me} busy={save.isPending} onSave={onSave} onConflict={onConflict} />
      </Section>

      <Section title="Security">
        {passwordDone !== null ? (
          <p role="status" className="mb-3 rounded-lg bg-[var(--color-good-soft)] px-3 py-2.5 text-sm text-[var(--color-good)]">
            Password changed.{passwordDone > 0 ? ` ${passwordDone} other ${passwordDone === 1 ? 'device was' : 'devices were'} signed out.` : ''}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={secondaryButton} onClick={() => { setPasswordDone(null); setChangingPassword(true) }}>
            Change password
          </button>
          <Link to="/account/security" className="text-sm font-medium text-[var(--color-accent)] hover:underline">
            Manage signed-in devices
          </Link>
        </div>
      </Section>

      {changingPassword ? (
        <ChangePasswordDialog
          email={me.email}
          fullName={me.fullName}
          onClose={() => setChangingPassword(false)}
          onChanged={({ sessionsRevoked }) => {
            setChangingPassword(false)
            setPasswordDone(sessionsRevoked)
            void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
          }}
        />
      ) : null}
    </div>
  )
}
