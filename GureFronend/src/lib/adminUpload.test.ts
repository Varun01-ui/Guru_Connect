import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from './api'
import { uploadAdminFile } from './adminUpload'

vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), apiFetch: vi.fn() }))

const file = new File(['abc'], 'me.png', { type: 'image/png' })
const presigned = { fileId: 'f1', uploadUrl: 'https://storage.test/put?sig=1', method: 'PUT', headers: { 'Content-Type': 'image/png' }, expiresAt: '2030-01-01T00:00:00Z' }

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('uploadAdminFile', () => {
  it('presigns, PUTs the bytes to storage with the signed headers, then confirms', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(presigned).mockResolvedValueOnce({ fileId: 'f1', status: 'active', publicUrl: 'https://cdn.test/a.png' })
    const put = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', put)

    const result = await uploadAdminFile(file, 'admin_avatar')

    expect(result).toEqual({ fileId: 'f1', status: 'active', publicUrl: 'https://cdn.test/a.png' })
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/uploads/presign')
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0]![1]!.body as string)).toEqual({ purpose: 'admin_avatar', mimeType: 'image/png', sizeBytes: 3, fileName: 'me.png' })
    expect(put).toHaveBeenCalledWith('https://storage.test/put?sig=1', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: file })
    expect(vi.mocked(apiFetch).mock.calls[1]![0]).toBe('/uploads/f1/confirm')
  })

  it('stops with a friendly error if storage refuses the bytes, and never confirms', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(presigned)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    await expect(uploadAdminFile(file, 'banner_image')).rejects.toMatchObject({ message: "The upload didn't go through. Try again." })
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('reports a network failure the same way', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(presigned)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(uploadAdminFile(file, 'banner_image')).rejects.toBeInstanceOf(ApiError)
  })

  it('passes a presign rejection (for example a file that is too large) straight through', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError(413, 'FILE_TOO_LARGE', 'Files can be up to 2 MB.'))
    await expect(uploadAdminFile(file, 'admin_avatar')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
})
