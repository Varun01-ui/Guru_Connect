import { useQuery } from '@tanstack/react-query'
import { Modal } from '../../../components/shared/Modal'
import { ApiError } from '../../../lib/api'
import { formatDateTime } from '../../../lib/format'
import { fetchSetting } from '../api/settings.api'

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

const ACTION_LABELS: Record<string, string> = {
  'setting.updated': 'Changed',
  'setting.maintenance_enabled': 'Maintenance switched on',
  'setting.maintenance_disabled': 'Maintenance switched off',
}

// FR-4.7: the audit trail of one setting, newest first.
export function SettingHistoryDrawer({ settingKey, label, onClose }: { settingKey: string; label: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ['settings', 'history', settingKey], queryFn: () => fetchSetting(settingKey) })

  return (
    <Modal title={`History · ${label}`} description={settingKey} size="md" onClose={onClose}>
      {query.isPending ? (
        <p className="text-sm text-[var(--color-fg-muted)]">Loading history…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-[var(--color-bad)]">
          {query.error instanceof ApiError ? query.error.message : 'Could not load the history.'}
        </p>
      ) : query.data.history.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">No changes recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {query.data.history.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                <time className="text-xs text-[var(--color-fg-muted)]" dateTime={entry.at}>
                  {formatDateTime(entry.at)}
                </time>
              </div>
              <p className="mt-1 break-words text-[13px]">
                <span className="text-[var(--color-fg-muted)] line-through">{show(entry.oldValue)}</span> → <span className="font-medium">{show(entry.newValue)}</span>
              </p>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {entry.actorEmail ?? 'System'}
                {entry.reason ? ` · “${entry.reason}”` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-5 flex justify-end">
        <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
