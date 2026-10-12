import { BUCKETS } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'

// Mobile conventions §10: which purposes exist, where they live, what they may contain and how big they may be.
const MB = 1024 * 1024
const IMAGES = ['image/jpeg', 'image/png', 'image/webp']
const DOCUMENTS = ['image/jpeg', 'image/png', 'application/pdf']

export type UploadPurposeConfig = { bucket: Bucket; visibility: 'public' | 'private'; prefix: string; mimeTypes: string[]; maxBytes: number }

export const UPLOAD_PURPOSES = {
  avatar: { bucket: BUCKETS.public, visibility: 'public', prefix: 'avatars', mimeTypes: IMAGES, maxBytes: 5 * MB },
  teacher_photo: { bucket: BUCKETS.public, visibility: 'public', prefix: 'teacher-photos', mimeTypes: IMAGES, maxBytes: 5 * MB },
  institute_logo: { bucket: BUCKETS.public, visibility: 'public', prefix: 'institute-logos', mimeTypes: IMAGES, maxBytes: 5 * MB },
  institute_cover: { bucket: BUCKETS.public, visibility: 'public', prefix: 'institute-covers', mimeTypes: IMAGES, maxBytes: 5 * MB },
  institute_gallery: { bucket: BUCKETS.public, visibility: 'public', prefix: 'institute-gallery', mimeTypes: IMAGES, maxBytes: 5 * MB },
  teacher_document: { bucket: BUCKETS.private, visibility: 'private', prefix: 'teacher-docs', mimeTypes: DOCUMENTS, maxBytes: 10 * MB },
  institute_document: { bucket: BUCKETS.private, visibility: 'private', prefix: 'institute-docs', mimeTypes: DOCUMENTS, maxBytes: 10 * MB },
  complaint_evidence: { bucket: BUCKETS.private, visibility: 'private', prefix: 'complaints', mimeTypes: DOCUMENTS, maxBytes: 10 * MB },
  support_attachment: { bucket: BUCKETS.private, visibility: 'private', prefix: 'support', mimeTypes: DOCUMENTS, maxBytes: 10 * MB },
} as const satisfies Record<string, UploadPurposeConfig>

// Files uploaded by admins through /api/v1/admin/uploads (M03 avatar, M44 banner image). Kept apart from the app
// purposes so a mobile user can never presign one of these.
export const ADMIN_UPLOAD_PURPOSES = {
  admin_avatar: { bucket: BUCKETS.public, visibility: 'public', prefix: 'admin-avatars', mimeTypes: IMAGES, maxBytes: 2 * MB },
  banner_image: { bucket: BUCKETS.public, visibility: 'public', prefix: 'banners', mimeTypes: IMAGES, maxBytes: 500 * 1024 },
} as const satisfies Record<string, UploadPurposeConfig>

export type AdminUploadPurpose = keyof typeof ADMIN_UPLOAD_PURPOSES
export const ADMIN_UPLOAD_PURPOSE_NAMES = Object.keys(ADMIN_UPLOAD_PURPOSES) as [AdminUploadPurpose, ...AdminUploadPurpose[]]

export type UploadPurpose = keyof typeof UPLOAD_PURPOSES
export const UPLOAD_PURPOSE_NAMES = Object.keys(UPLOAD_PURPOSES) as [UploadPurpose, ...UploadPurpose[]]

export const PRESIGN_TTL_SECONDS = 10 * 60
export const GET_URL_TTL_SECONDS = 60
export const MAX_PENDING_UPLOADS = 20
export const STALE_PENDING_HOURS = 24

export const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}
