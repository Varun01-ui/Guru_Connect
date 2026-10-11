import { StatusBadge } from '../../../components/shared/StatusBadge'
import type { AdminStatus } from '../api/rbac.api'

const TONE = { active: 'good', invited: 'info', locked: 'warn', disabled: 'bad' } as const
const LABEL: Record<AdminStatus, string> = { active: 'Active', invited: 'Invited', locked: 'Locked', disabled: 'Disabled' }

export function AdminStatusBadge({ status }: { status: AdminStatus }) {
  return <StatusBadge tone={TONE[status]}>{LABEL[status]}</StatusBadge>
}
