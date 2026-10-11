import { useEffect, useRef } from 'react'
import { IconLock } from '../../../components/icons'
import type { PermissionGroup } from '../api/rbac.api'

type Props = {
  catalogue: PermissionGroup[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** Nobody can change it (no permission, or Super Admin who always holds everything). */
  readOnly?: boolean
}

const titleCase = (module: string) => module.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase())
const action = (key: string) => key.slice(key.indexOf('.') + 1).replace(/[_.]/g, ' ')

function ModuleToggle({ label, checked, indeterminate, disabled, onChange }: { label: string; checked: boolean; indeterminate: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-fg-muted)]">
      <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
      Select all
    </label>
  )
}

// Permissions grouped by module, one checkbox per key. A lock marks the sensitive ones, which need a reason to grant.
export function PermissionMatrix({ catalogue, selected, onChange, readOnly = false }: Props) {
  function toggle(keys: string[], on: boolean) {
    const next = new Set(selected)
    for (const key of keys) {
      if (on) next.add(key)
      else next.delete(key)
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {catalogue.map((group) => {
        const keys = group.permissions.map((p) => p.key)
        const count = keys.filter((k) => selected.has(k)).length
        return (
          <section key={group.module} aria-label={titleCase(group.module)} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5">
              <h3 className="text-sm font-semibold">
                {titleCase(group.module)}
                <span className="ml-2 text-xs font-normal text-[var(--color-fg-muted)]">
                  {count} of {keys.length}
                </span>
              </h3>
              <ModuleToggle
                label={`Select all in ${titleCase(group.module)}`}
                checked={count === keys.length && keys.length > 0}
                indeterminate={count > 0 && count < keys.length}
                disabled={readOnly}
                onChange={(on) => toggle(keys, on)}
              />
            </header>
            <ul className="divide-y divide-[var(--color-border)]">
              {group.permissions.map((p) => (
                <li key={p.key}>
                  <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <input
                      type="checkbox"
                      checked={selected.has(p.key)}
                      disabled={readOnly}
                      onChange={(e) => toggle([p.key], e.target.checked)}
                      aria-label={p.key}
                      className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="capitalize">{action(p.key)}</span>
                        <span className="font-mono text-xs font-normal text-[var(--color-fg-muted)]">{p.key}</span>
                        {p.isSensitive ? (
                          <span title="Sensitive: granting it needs a reason" className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warn-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-warn)]">
                            <IconLock className="h-3 w-3" aria-hidden="true" />
                            Sensitive
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-xs text-[var(--color-fg-muted)]">{p.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
