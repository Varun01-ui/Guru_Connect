import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError } from '../../../../lib/api'
import { uploadAdminFile } from '../../../../lib/adminUpload'
import { AUDIENCES, fetchCityOptions, PLACEMENTS } from '../api/banners.api'
import type { Audience, Placement } from '../api/banners.api'
import type { FormValues } from '../form'
import { DeepLinkPicker } from './DeepLinkPicker'

type Props = {
  values: FormValues
  errors: Record<string, string>
  disabled?: boolean
  onChange: (patch: Partial<FormValues>) => void
}

const input =
  'mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)] aria-[invalid=true]:border-[var(--color-bad)] disabled:cursor-not-allowed disabled:opacity-60'
const TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 500 * 1024

// Reads the pixel size in the browser so a wrong-sized image is caught before it is uploaded. Where the browser can't
// decode it here, the server's check (the same rule) still applies.
async function pixelSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file)
    return { width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  }
}

export function BannerForm({ values, errors, disabled, onChange }: Props) {
  const cities = useQuery({ queryKey: ['banners', 'cities'], queryFn: fetchCityOptions, staleTime: 10 * 60_000 })
  const [cityFilter, setCityFilter] = useState('')
  const [uploading, setUploading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function pickImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImageError(null)
    if (!TYPES.includes(file.type)) return setImageError('Upload a JPG, PNG or WebP image.')
    if (file.size > MAX_BYTES) return setImageError('Banner images can be up to 500 KB.')
    const size = await pixelSize(file)
    if (size && (Math.abs(size.width - 1080) > 2 || Math.abs(size.height - 480) > 2)) return setImageError('Banner images must be 1080 × 480 px.')
    setUploading(true)
    try {
      const uploaded = await uploadAdminFile(file, 'banner_image')
      onChange({ imageFileId: uploaded.fileId, imageUrl: uploaded.publicUrl })
    } catch (e) {
      setImageError(e instanceof ApiError ? e.message : 'Could not upload the image. Try again.')
    } finally {
      setUploading(false)
    }
  }

  const error = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
        {errors[key]}
      </p>
    ) : null
  const toggleCity = (id: string) => onChange({ cityIds: values.cityIds.includes(id) ? values.cityIds.filter((c) => c !== id) : [...values.cityIds, id] })
  const shownCities = (cities.data ?? []).filter((c) => c.name.toLowerCase().includes(cityFilter.trim().toLowerCase()))

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="bn-title" className="text-sm font-medium">
          Title
        </label>
        <input id="bn-title" value={values.title} disabled={disabled} onChange={(e) => onChange({ title: e.target.value })} aria-invalid={errors.title ? true : undefined} className={`${input} h-10`} placeholder="Board exams in 90 days" />
        {error('title')}
      </div>
      <div>
        <label htmlFor="bn-subtitle" className="text-sm font-medium">
          Subtitle <span className="font-normal text-[var(--color-fg-muted)]">(optional)</span>
        </label>
        <input id="bn-subtitle" value={values.subtitle} disabled={disabled} onChange={(e) => onChange({ subtitle: e.target.value })} aria-invalid={errors.subtitle ? true : undefined} className={`${input} h-10`} placeholder="Book a free demo with a verified teacher" />
        {error('subtitle')}
      </div>

      <div>
        <span className="text-sm font-medium">Image</span>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          {values.imageUrl ? <img src={values.imageUrl} alt="Banner artwork" className="aspect-[2.25/1] w-44 rounded-lg object-cover ring-1 ring-[var(--color-border)]" /> : null}
          <button type="button" disabled={disabled || uploading} onClick={() => fileInput.current?.click()} className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-60">
            {uploading ? 'Uploading…' : values.imageFileId ? 'Replace image' : 'Upload image'}
          </button>
          <input ref={fileInput} type="file" accept={TYPES.join(',')} aria-label="Choose banner image" className="sr-only" tabIndex={-1} onChange={(e) => void pickImage(e)} />
        </div>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">1080 × 480 px, JPG, PNG or WebP, up to 500 KB.</p>
        {imageError || errors.imageFileId ? (
          <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
            {imageError ?? errors.imageFileId}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="bn-placement" className="text-sm font-medium">
            Where it shows
          </label>
          <select id="bn-placement" value={values.placement} disabled={disabled} onChange={(e) => onChange({ placement: e.target.value as Placement })} className={`${input} h-10`}>
            {PLACEMENTS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bn-audience" className="text-sm font-medium">
            Who sees it
          </label>
          <select id="bn-audience" value={values.audience} disabled={disabled} onChange={(e) => onChange({ audience: e.target.value as Audience })} className={`${input} h-10`}>
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">
          Cities <span className="font-normal text-[var(--color-fg-muted)]">({values.cityIds.length === 0 ? 'none picked = all cities' : `${values.cityIds.length} picked`})</span>
        </legend>
        <label htmlFor="bn-city-filter" className="sr-only">
          Filter cities
        </label>
        <input id="bn-city-filter" type="search" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} placeholder="Filter cities" className={`${input} h-9`} />
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] p-1.5">
          {cities.isPending ? <p className="p-2 text-xs text-[var(--color-fg-muted)]">Loading cities…</p> : null}
          {cities.isError ? <p role="alert" className="p-2 text-xs text-[var(--color-bad)]">Could not load the cities.</p> : null}
          {shownCities.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-2)]">
              <input type="checkbox" checked={values.cityIds.includes(c.id)} disabled={disabled} onChange={() => toggleCity(c.id)} className="h-4 w-4 accent-[var(--color-accent)]" />
              {c.name}
            </label>
          ))}
        </div>
        {error('cityIds')}
      </fieldset>

      <DeepLinkPicker value={values.deepLink} disabled={disabled} error={errors.deepLink} onChange={(deepLink) => onChange({ deepLink })} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="bn-starts" className="text-sm font-medium">
            Starts
          </label>
          <input id="bn-starts" type="datetime-local" value={values.startsAt} disabled={disabled} onChange={(e) => onChange({ startsAt: e.target.value })} aria-invalid={errors.startsAt ? true : undefined} className={`${input} h-10`} />
          {error('startsAt')}
        </div>
        <div>
          <label htmlFor="bn-ends" className="text-sm font-medium">
            Ends <span className="font-normal text-[var(--color-fg-muted)]">(optional)</span>
          </label>
          <input id="bn-ends" type="datetime-local" value={values.endsAt} disabled={disabled} onChange={(e) => onChange({ endsAt: e.target.value })} aria-invalid={errors.endsAt ? true : undefined} className={`${input} h-10`} />
          {error('endsAt')}
        </div>
        <div>
          <label htmlFor="bn-priority" className="text-sm font-medium">
            Priority (0–100)
          </label>
          <input id="bn-priority" type="number" min={0} max={100} value={values.priority} disabled={disabled} onChange={(e) => onChange({ priority: Number(e.target.value) })} aria-invalid={errors.priority ? true : undefined} className={`${input} h-10`} />
          {error('priority')}
        </div>
      </div>
    </div>
  )
}
