type Props = {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}

// Inline on/off toggle. The caller applies the change optimistically and rolls back on error.
export function StatusSwitch({ checked, label, disabled, onChange }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-[var(--color-good)]' : 'bg-[var(--color-border)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
      />
    </button>
  )
}
