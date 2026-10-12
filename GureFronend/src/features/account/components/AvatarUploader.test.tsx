import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { uploadAdminFile } from '../../../lib/adminUpload'
import { removeAvatar, setAvatar } from '../api/account.api'
import { profile } from '../testData'
import { AvatarUploader } from './AvatarUploader'

vi.mock('../../../lib/adminUpload')
vi.mock('../api/account.api')

const onChanged = vi.fn()
const withPhoto = { ...profile, avatar: { fileId: 'f1', url: 'https://cdn.test/admin-avatars/me.jpg' } }
const show = (p: Parameters<typeof AvatarUploader>[0]['profile'] = profile) => render(<AvatarUploader profile={p} onChanged={onChanged} />)
const choose = (file: File) => fireEvent.change(screen.getByLabelText('Choose a profile photo'), { target: { files: [file] } })
const png = (size = 100) => new File([new Uint8Array(size)], 'me.png', { type: 'image/png' })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(uploadAdminFile).mockResolvedValue({ fileId: 'f2', status: 'active', publicUrl: 'https://cdn.test/x.png' })
  vi.mocked(setAvatar).mockResolvedValue(withPhoto)
  vi.mocked(removeAvatar).mockResolvedValue(profile)
})
// jsdom has no createImageBitmap, which is exactly the "can't crop" fallback.
afterEach(() => vi.unstubAllGlobals())

describe('AvatarUploader', () => {
  it('shows initials when there is no photo, and offers Upload', () => {
    show()
    expect(screen.getByText('AM')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('shows the photo, with Change and Remove', () => {
    show(withPhoto)
    expect(screen.getByRole('img', { name: "Anjali Menon's photo" })).toHaveAttribute('src', 'https://cdn.test/admin-avatars/me.jpg')
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('uploads the chosen image, then sets it as the avatar', async () => {
    show()
    const file = png()
    choose(file)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(withPhoto))
    expect(uploadAdminFile).toHaveBeenCalledWith(file, 'admin_avatar')
    expect(setAvatar).toHaveBeenCalledWith('f2')
  })

  it('crops to a square when the browser can', async () => {
    const drawImage = vi.fn()
    const cropped = new Blob(['cropped'], { type: 'image/jpeg' })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 800, height: 600 }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(cropped))
    show()
    choose(png())
    await waitFor(() => expect(setAvatar).toHaveBeenCalled())
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 0, 600, 600, 0, 0, 512, 512)
    const sent = vi.mocked(uploadAdminFile).mock.calls[0]![0] as File
    expect(sent.name).toBe('avatar.jpg')
    expect(sent.type).toBe('image/jpeg')
    expect(sent.size).toBe(cropped.size)
  })

  it('rejects other file types without uploading', async () => {
    show()
    choose(new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload a JPG, PNG or WebP image.')
    expect(uploadAdminFile).not.toHaveBeenCalled()
  })

  it('rejects an image over 2 MB when it cannot be shrunk', async () => {
    show()
    choose(png(2 * 1024 * 1024 + 1))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an image under 2 MB.')
    expect(uploadAdminFile).not.toHaveBeenCalled()
  })

  it('shows the server’s reason when the upload fails', async () => {
    vi.mocked(uploadAdminFile).mockRejectedValue(new ApiError(415, 'FILE_TYPE_NOT_ALLOWED', "That file doesn't match its type."))
    show()
    choose(png())
    expect(await screen.findByRole('alert')).toHaveTextContent("That file doesn't match its type.")
    expect(setAvatar).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('removes the photo', async () => {
    show(withPhoto)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(profile))
    expect(removeAvatar).toHaveBeenCalled()
  })

  it('shows a failure to remove', async () => {
    vi.mocked(removeAvatar).mockRejectedValue(new Error('boom'))
    show(withPhoto)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove the photo. Try again.')
  })
})
