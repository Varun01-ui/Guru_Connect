import { ApiError, apiFetch } from './api'

export type AdminUploadPurpose = 'admin_avatar' | 'banner_image'

type Presigned = { fileId: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string }
export type ConfirmedUpload = { fileId: string; status: string; publicUrl: string | null }

// M00 BR-0.8 for admins: ask for a presigned URL, send the bytes straight to storage, then confirm.
export async function uploadAdminFile(file: Blob & { name?: string }, purpose: AdminUploadPurpose): Promise<ConfirmedUpload> {
  const presigned = await apiFetch<Presigned>('/uploads/presign', {
    method: 'POST',
    body: JSON.stringify({ purpose, mimeType: file.type, sizeBytes: file.size, fileName: file.name ?? 'upload' }),
  })
  let response: Response
  try {
    response = await fetch(presigned.uploadUrl, { method: 'PUT', headers: presigned.headers, body: file })
  } catch {
    throw new ApiError(0, 'GATEWAY_ERROR', "The upload didn't go through. Check your connection and try again.")
  }
  if (!response.ok) throw new ApiError(response.status, 'GATEWAY_ERROR', "The upload didn't go through. Try again.")
  return apiFetch<ConfirmedUpload>(`/uploads/${presigned.fileId}/confirm`, { method: 'POST' })
}
