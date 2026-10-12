import { useRef, useState } from 'react'
import { ApiError } from '../../../lib/api'
import { uploadAdminFile } from '../../../lib/adminUpload'
import { removeAvatar, setAvatar } from '../api/account.api'
import type { Profile } from '../api/account.api'
import { secondaryButton } from '../formUtils'

type Props = { profile: Pick<Profile, 'fullName' | 'avatar'>; onChanged: (profile: Profile) => void }

const TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 2 * 1024 * 1024
const SIZE = 512

// Centre-crops to a square and shrinks, so every avatar looks the same wherever it is shown. Where the browser can't
// do that (no canvas), the original file goes up unchanged.
async function squareCrop(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    return blob ?? file
  } catch {
    return file
  }
}

const initials = (name: string) => {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function AvatarUploader({ profile, onChanged }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    if (!TYPES.includes(file.type)) return setError('Upload a JPG, PNG or WebP image.')
    setBusy(true)
    try {
      const prepared = await squareCrop(file)
      if (prepared.size > MAX_BYTES) {
        setError('Choose an image under 2 MB.')
        return
      }
      const named = prepared instanceof File ? prepared : new File([prepared], 'avatar.jpg', { type: prepared.type })
      const uploaded = await uploadAdminFile(named, 'admin_avatar')
      onChanged(await setAvatar(uploaded.fileId))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not upload the photo. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setError(null)
    setBusy(true)
    try {
      onChanged(await removeAvatar())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the photo. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      {profile.avatar?.url ? (
        <img src={profile.avatar.url} alt={`${profile.fullName}'s photo`} className="h-20 w-20 rounded-full object-cover ring-2 ring-[var(--color-border)]" />
      ) : (
        <span aria-hidden="true" className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-accent)] text-xl font-bold text-white">
          {initials(profile.fullName)}
        </span>
      )}
      <div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Working…' : profile.avatar ? 'Change photo' : 'Upload photo'}
          </button>
          {profile.avatar ? (
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          ) : null}
        </div>
        <input ref={input} type="file" accept={TYPES.join(',')} aria-label="Choose a profile photo" className="sr-only" tabIndex={-1} onChange={(e) => void pick(e)} />
        <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">JPG, PNG or WebP. It is cropped to a square.</p>
        {error ? (
          <p role="alert" className="mt-1.5 text-xs text-[var(--color-bad)]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
