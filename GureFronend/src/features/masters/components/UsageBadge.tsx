import { StatusBadge } from '../../../components/shared/StatusBadge'

// How many live records use a master row: "Unused", "1 state", "13 states".
export function UsageBadge({ count, label }: { count: number; label: (count: number) => string }) {
  return <StatusBadge tone={count === 0 ? 'neutral' : 'info'}>{label(count)}</StatusBadge>
}
