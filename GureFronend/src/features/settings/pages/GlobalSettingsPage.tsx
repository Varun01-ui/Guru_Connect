import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchSettings } from '../api/settings.api'
import type { SettingGroup } from '../api/settings.api'
import { SettingsGroupForm } from '../components/SettingsGroupForm'
import { groupLabel, MAINTENANCE_KEY } from '../validate'

const SETTINGS_KEY = ['settings'] as const

export function GlobalSettingsPage() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings })
  const [active, setActive] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // Bumped on "Reload latest" so each tab's form starts again from the server's values.
  const [reloads, setReloads] = useState(0)

  if (query.isPending) return <p className="text-sm text-[var(--color-fg-muted)]">Loading settings…</p>
  if (query.isError) {
    return (
      <div role="alert" className="text-sm">
        <p className="text-[var(--color-bad)]">{query.error instanceof ApiError ? query.error.message : 'Could not load the settings.'}</p>
        <button type="button" className="mt-3 font-medium text-[var(--color-accent)] hover:underline" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    )
  }

  const groups = query.data.groups
  const current = groups.find((g) => g.group === active) ?? groups[0]
  const maintenanceOn = groups.flatMap((g) => g.settings).some((s) => s.key === MAINTENANCE_KEY && s.value === true)
  const canEdit = can('settings.update')

  function onSaved(saved: SettingGroup) {
    queryClient.setQueryData(SETTINGS_KEY, (old: { groups: SettingGroup[] } | undefined) =>
      old ? { groups: old.groups.map((g) => (g.group === saved.group ? saved : g)) } : old,
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold">Global settings</h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Platform-wide values the mobile app reads. Changes apply without a deploy and are kept in the history.</p>

      {maintenanceOn ? (
        <div role="status" className="mt-4 rounded-xl border border-[var(--color-bad)]/30 bg-[var(--color-bad-soft)] px-4 py-3 text-sm text-[var(--color-bad)]">
          <strong>Maintenance mode is on.</strong> The mobile app shows a maintenance screen. The admin portal is not affected.
        </div>
      ) : null}
      {!canEdit ? <p className="mt-4 rounded-lg bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-fg-muted)]">You can view these settings but not change them.</p> : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]">
        <div role="tablist" aria-label="Setting groups" className="flex flex-wrap gap-1">
          {groups.map((g) => {
            const selected = g.group === current?.group
            return (
              <button
                key={g.group}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setActive(g.group)}
                className={`-mb-px rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  selected ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {groupLabel(g.group)}
              </button>
            )
          })}
        </div>
        <div className="pb-2">
          <label htmlFor="settings-filter" className="sr-only">
            Filter settings
          </label>
          <input
            id="settings-filter"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or key"
            className="h-9 w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </div>

      <div role="tabpanel" className="mt-6">
        {current ? (
          <SettingsGroupForm
            key={`${current.group}-${reloads}`}
            group={current.group}
            settings={current.settings}
            filter={filter}
            canEdit={canEdit}
            onSaved={onSaved}
            onReload={() => {
              void query.refetch().then(() => setReloads((n) => n + 1))
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
