import { IconAward, IconBookOpen, IconClock, IconGraduationCap, IconRupee, IconShieldCheck, IconUserPlus, IconUsers } from '../../../components/icons'
import { KpiCard } from '../../../components/shared/KpiCard'
import { useAuth } from '../../auth/authStore'

const KPIS = [
  { label: 'Total Teachers', value: '4,820', icon: <IconGraduationCap />, delta: 6.8, hint: 'vs last month' },
  { label: 'Verified Teachers', value: '3,791', icon: <IconShieldCheck />, delta: 5.1, hint: '78.6% of total', tone: 'good' as const },
  { label: 'Pending Approvals', value: '112', icon: <IconClock />, delta: -12, hint: 'avg wait 6.2h', tone: 'warn' as const },
  { label: 'Total Parents', value: '9,340', icon: <IconUsers />, delta: 8.4, hint: 'vs last month' },
  { label: 'Total Students', value: '12,610', icon: <IconBookOpen />, delta: 9.7, hint: 'vs last month' },
  { label: 'Active Subscriptions', value: '6,205', icon: <IconAward />, delta: 4.2, hint: 'teachers + learners' },
  { label: 'Revenue (MTD)', value: '₹18.4L', icon: <IconRupee />, delta: 11.3, hint: 'vs same day last month' },
  { label: 'New Registrations Today', value: '386', icon: <IconUserPlus />, delta: 3.9, hint: '41 teachers · 345 users' },
]

const NEXT_MODULES = [
  { code: 'M03', name: 'Admin Profile Management', note: 'Avatar, timezone, theme, notification prefs' },
  { code: 'M04', name: 'Global Settings', note: 'Maintenance mode, contact & legal settings' },
]

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
  const { admin } = useAuth()
  const firstName = admin?.fullName?.split(' ')[0] ?? 'there'
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">Platform snapshot for {today}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((kpi, i) => (
          <KpiCard key={kpi.label} {...kpi} style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="animate-[fade-in-up_0.5s_ease-out_backwards] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)]">
          <h2 className="text-[15px] font-semibold">Sample data</h2>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-muted)]">
            These numbers are placeholders. They'll become real once <b>M47 Dashboard Analytics</b> and the modules that
            feed it (teachers, institutes, payments, reviews…) are implemented.
          </p>
          <div className="mt-4 h-40 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]" />
        </div>

        <div className="animate-[fade-in-up_0.5s_ease-out_backwards] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)]" style={{ animationDelay: '80ms' }}>
          <h2 className="text-[15px] font-semibold">Build order — what's next</h2>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-muted)]">M01 Authentication is done. Next up, in order:</p>
          <ul className="mt-3 flex flex-col gap-3">
            {NEXT_MODULES.map((m) => (
              <li key={m.code} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-[var(--font-mono)] text-[11px] font-semibold text-[var(--color-accent)]">
                  {m.code}
                </span>
                <div>
                  <div className="font-medium leading-tight">{m.name}</div>
                  <div className="text-[12.5px] text-[var(--color-fg-muted)]">{m.note}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
