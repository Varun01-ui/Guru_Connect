type Item = { id?: string; title: string; subtitle?: string | null; imageUrl?: string | null }

// A phone-shaped frame showing banners at the 2.25:1 shape the app uses. Used for the live preview in the editor
// (one banner) and for "what a parent in Bengaluru sees" on the list page (several).
export function PhonePreview({ items, caption, emptyText = 'Nothing to show here.' }: { items: Item[]; caption?: string; emptyText?: string }) {
  return (
    <figure className="mx-auto w-[240px]">
      <div className="rounded-[28px] border-[6px] border-[var(--color-navy)] bg-[var(--color-surface-2)] p-2.5 shadow-[var(--shadow-card)]">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--color-border)]" aria-hidden="true" />
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="px-2 py-10 text-center text-xs text-[var(--color-fg-muted)]">{emptyText}</p>
          ) : (
            items.map((item, index) => (
              <div key={item.id ?? index} data-testid="preview-banner" className="relative aspect-[2.25/1] overflow-hidden rounded-xl bg-[var(--color-accent-soft)]">
                {item.imageUrl ? <img src={item.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : null}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-white">
                  <div className="truncate text-[12px] font-semibold leading-tight">{item.title || 'Your headline'}</div>
                  {item.subtitle ? <div className="truncate text-[10px] opacity-90">{item.subtitle}</div> : null}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      {caption ? <figcaption className="mt-2 text-center text-xs text-[var(--color-fg-muted)]">{caption}</figcaption> : null}
    </figure>
  )
}
