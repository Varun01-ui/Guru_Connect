import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { IconLock, IconLogOut, IconShieldCheck } from '../components/icons'
import { logout } from '../features/auth/api/auth.api'
import { useAuth } from '../features/auth/authStore'
import { usePermissions } from '../features/auth/usePermissions'

// Sidebar entries grow one line per module as each ships (04-react-app-structure.md has the full map).
const NAV: { section: string; items: { to: string; label: string; permission?: string; end?: boolean }[] }[] = [
  { section: 'Overview', items: [{ to: '/', label: 'Dashboard', end: true }] },
  {
    section: 'Masters',
    items: [
      { to: '/masters/locations/countries', label: 'Countries', permission: 'locations.read' },
      { to: '/masters/locations/states', label: 'States', permission: 'locations.read' },
      { to: '/masters/education/classes', label: 'Classes', permission: 'education_masters.read' },
      { to: '/masters/education/teaching-modes', label: 'Teaching modes', permission: 'education_masters.read' },
      { to: '/masters/education/teacher-categories', label: 'Teacher categories', permission: 'education_masters.read' },
    ],
  },
]

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function AppShell({ children }: { children: ReactNode }) {
  const { admin } = useAuth()
  const { can } = usePermissions()

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      <aside className="flex w-64 shrink-0 flex-col bg-[var(--color-navy)] text-[var(--color-navy-ink)]">
        <div className="flex items-center gap-3 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[linear-gradient(145deg,#6d67ff,#4338ca)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]">
            <IconShieldCheck className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="font-[var(--font-display)] text-[15px] font-semibold text-white">GuruConnect</div>
            <div className="text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-navy-ink-muted)]">Admin</div>
          </div>
        </div>

        <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {NAV.map((group) => {
            const items = group.items.filter((item) => !item.permission || can(item.permission))
            if (items.length === 0) return null
            return (
              <div key={group.section}>
                <div className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-navy-ink-muted)]">{group.section}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `block rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${
                        isActive ? 'bg-[var(--color-navy-2)] text-white' : 'text-[var(--color-navy-ink)] hover:bg-[var(--color-navy-2)]/60 hover:text-white'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )
          })}
        </nav>

        {admin ? (
          <div className="m-3 flex items-center gap-2.5 rounded-xl bg-[var(--color-navy-2)] p-3">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[var(--color-accent)] text-xs font-bold text-white">
              {initials(admin.fullName)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13.5px] font-semibold text-white">{admin.fullName}</div>
              <div className="truncate text-[11.5px] text-[var(--color-navy-ink-muted)]">
                {admin.isSuperAdmin ? 'Super Admin' : 'Admin'}
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 px-6 py-3.5 backdrop-blur">
          <Link
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
            to="/account/security"
          >
            <IconLock className="h-4 w-4" />
            Account security
          </Link>
          <button
            className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-bad)]/40 hover:text-[var(--color-bad)]"
            onClick={() => logout()}
            type="button"
          >
            <IconLogOut className="h-4 w-4" />
            Sign out
          </button>
        </header>
        <main className="flex-1 animate-[fade-in_0.35s_ease-out] p-6">{children}</main>
      </div>
    </div>
  )
}
