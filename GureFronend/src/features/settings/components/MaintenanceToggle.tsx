import { useState } from 'react'
import { Modal } from '../../../components/shared/Modal'
import { StatusSwitch } from '../../../components/shared/StatusSwitch'

type Props = {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}

const PHRASE = 'MAINTENANCE'

// Switching maintenance mode ON needs a typed confirmation (FR-4.4); switching it off is immediate.
export function MaintenanceToggle({ checked, disabled, onChange }: Props) {
  const [asking, setAsking] = useState(false)
  const [typed, setTyped] = useState('')

  function close() {
    setAsking(false)
    setTyped('')
  }

  return (
    <>
      <StatusSwitch
        checked={checked}
        label="Maintenance mode"
        disabled={disabled}
        onChange={(next) => {
          if (next) setAsking(true)
          else onChange(false)
        }}
      />
      {asking ? (
        <Modal title="Switch on maintenance mode?" size="sm" onClose={close}>
          <p className="rounded-lg bg-[var(--color-bad-soft)] px-3 py-2.5 text-sm text-[var(--color-bad)]">
            Every mobile app screen except sign-in will show the maintenance message until you switch this off. The admin portal is not affected.
          </p>
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (typed !== PHRASE) return
              onChange(true)
              close()
            }}
          >
            <label htmlFor="maintenance-confirm" className="text-sm font-medium">
              Type {PHRASE} to confirm
            </label>
            <input
              id="maintenance-confirm"
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-bad)]"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)]" onClick={close}>
                Cancel
              </button>
              <button type="submit" disabled={typed !== PHRASE} className="rounded-lg bg-[var(--color-bad)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                Switch on
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  )
}
