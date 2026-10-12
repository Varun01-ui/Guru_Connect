import { useId, useState } from 'react'
import { buildDeepLink, deepLinkProblem, LINK_KINDS, parseDeepLink } from '../deepLink'
import type { LinkKind, LinkParts } from '../deepLink'

type Props = { value: string | null; error?: string | null; disabled?: boolean; onChange: (link: string | null) => void }

const input =
  'mt-1.5 h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-[var(--color-accent)] aria-[invalid=true]:border-[var(--color-bad)] disabled:opacity-60'

// FR-44.5 / section 15: pick what the tap opens, then fill in just that kind's detail. The link is rebuilt on every change.
export function DeepLinkPicker({ value, error, disabled, onChange }: Props) {
  const id = useId()
  const [parts, setParts] = useState<LinkParts>(() => parseDeepLink(value))
  const problem = deepLinkProblem(parts)

  function update(next: LinkParts) {
    setParts(next)
    onChange(deepLinkProblem(next) ? null : buildDeepLink(next))
  }

  const detail = {
    search: { label: 'Search filters', key: 'search', placeholder: 'classId=10&subjectId=maths' },
    blog: { label: 'Article slug', key: 'blog', placeholder: 'how-to-pick-a-tutor' },
    teacher: { label: 'Teacher id', key: 'teacher', placeholder: '2d7c9a4e-…' },
    web: { label: 'Website link', key: 'web', placeholder: 'https://guruconnect.in/offers' },
  } as const
  const field = parts.kind in detail ? detail[parts.kind as keyof typeof detail] : null
  const shown = problem ?? error ?? null

  return (
    <div>
      <label htmlFor={`${id}-kind`} className="text-sm font-medium">
        When tapped, open
      </label>
      <select id={`${id}-kind`} value={parts.kind} disabled={disabled} onChange={(e) => update({ ...parts, kind: e.target.value as LinkKind })} className={input}>
        {LINK_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      {field ? (
        <div className="mt-3">
          <label htmlFor={`${id}-detail`} className="text-sm font-medium">
            {field.label}
          </label>
          <input
            id={`${id}-detail`}
            value={parts[field.key]}
            disabled={disabled}
            placeholder={field.placeholder}
            onChange={(e) => update({ ...parts, [field.key]: e.target.value })}
            aria-invalid={shown ? true : undefined}
            className={input}
          />
        </div>
      ) : null}
      {shown ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
          {shown}
        </p>
      ) : null}
    </div>
  )
}
