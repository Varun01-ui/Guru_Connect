import { randomUUID } from 'node:crypto'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import { fileTooLarge, fileTypeNotAllowed, gatewayError, limitReached, notFound, validationFailed } from '../../../lib/errors.js'
import { cdnUrl } from '../../../lib/present.js'
import { sniffMime, storage, storageIsConfigured } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'
import { EXTENSION_FOR_MIME, GET_URL_TTL_SECONDS, MAX_PENDING_UPLOADS, PRESIGN_TTL_SECONDS, UPLOAD_PURPOSES } from './uploads.config.js'
import type { UploadPurpose } from './uploads.config.js'
import * as repo from './uploads.repository.js'
import type { FileRow } from './uploads.repository.js'

export type UploadContext = { userId: string; ip: string | null }

const MB = 1024 * 1024
const baseMime = (value: string) => value.split(';')[0]!.trim().toLowerCase()

// 1) Presign: validate the request against the purpose's rules, record a pending file, hand back a short-lived PUT URL.
export async function presign(ctx: UploadContext, body: { purpose: UploadPurpose; mimeType: string; sizeBytes: number; fileName: string }) {
  if (!storageIsConfigured()) throw gatewayError("File storage isn't set up yet.")
  const rules = UPLOAD_PURPOSES[body.purpose]

  const allowed = rules.mimeTypes as readonly string[]
  if (!allowed.includes(body.mimeType)) {
    throw fileTypeNotAllowed(`Allowed types: ${allowed.map((m) => m.split('/')[1]).join(', ')}.`, { allowed })
  }
  if (body.sizeBytes > rules.maxBytes) {
    throw fileTooLarge(`Files can be up to ${rules.maxBytes / MB} MB.`, { maxBytes: rules.maxBytes })
  }

  const pending = await repo.countPendingFiles(ctx.userId)
  if (pending >= MAX_PENDING_UPLOADS) {
    throw limitReached(MAX_PENDING_UPLOADS, pending, 'Finish or cancel your other uploads first.', 'max_pending_uploads')
  }

  // The key is server-generated: the client's file name never reaches a path.
  const key = `${rules.prefix}/${ctx.userId}/${randomUUID()}.${EXTENSION_FOR_MIME[body.mimeType]}`
  const file = await repo.insertPendingFile(db, {
    bucket: rules.bucket,
    objectKey: key,
    originalName: body.fileName,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    visibility: rules.visibility,
    purpose: body.purpose,
    userId: ctx.userId,
  })

  const signed = storage.presignPut({ bucket: rules.bucket, key, contentType: body.mimeType, sizeBytes: body.sizeBytes, expiresInSeconds: PRESIGN_TTL_SECONDS })
  return { fileId: file.id, uploadUrl: signed.url, method: 'PUT' as const, headers: signed.headers, expiresAt: signed.expiresAt.toISOString() }
}

// A rejected upload is removed entirely (object and row) so a bad file never lingers.
async function reject(file: FileRow) {
  await storage.delete(file.bucket as Bucket, file.object_key).catch(() => undefined)
  await repo.softDeleteFile(file.id)
}

const summary = (file: FileRow) => ({
  fileId: file.id,
  // The API reports a verified file as "active" (M00 contract); the files table calls that state "uploaded".
  status: 'active' as const,
  publicUrl: file.visibility === 'public' ? cdnUrl(file.object_key) : null,
})

// 3) Confirm: check what actually landed in storage against what was promised at presign time.
export async function confirm(ctx: UploadContext, fileId: string) {
  const file = await repo.findOwnFile(fileId, ctx.userId)
  if (!file) throw notFound('File not found.')
  if (file.status === 'uploaded') return summary(file) // confirming twice is harmless
  if (file.status !== 'pending') throw notFound('File not found.')

  const bucket = file.bucket as Bucket
  const stored = await storage.head(bucket, file.object_key)
  if (!stored) throw validationFailed(undefined, "We couldn't find the uploaded file. Try uploading it again.")

  const declared = Number(file.size_bytes)
  if (stored.size > declared) {
    await reject(file)
    throw fileTooLarge('That file is larger than expected.')
  }
  if (stored.size < declared) throw validationFailed(undefined, 'The upload looks incomplete. Try uploading it again.')

  // Both the Content-Type the object was stored with and its actual bytes must match the declared type, so an
  // HTML page can't be smuggled onto the CDN as "image/jpeg".
  const head = await storage.peek(bucket, file.object_key, 16)
  if (baseMime(stored.contentType) !== file.mime_type || !head || sniffMime(head) !== file.mime_type) {
    await reject(file)
    throw fileTypeNotAllowed("That file doesn't match its type.")
  }

  if (!(await repo.markUploaded(file.id))) throw notFound('File not found.')
  await audit(db, {
    actorType: 'app_user',
    actorId: ctx.userId,
    action: 'app.file_uploaded',
    module: 'app.uploads',
    entityType: 'file',
    entityId: file.id,
    // Purpose, size and type only — never the file name (it can identify a document).
    newValues: { purpose: file.purpose, sizeBytes: declared, mimeType: file.mime_type },
    ip: ctx.ip,
  })
  return summary(file)
}

// GET /files/:id/url — owner only. Public files use the CDN URL; private ones get a 60 second signed link.
export async function fileUrl(ctx: UploadContext, fileId: string) {
  const file = await repo.findOwnFile(fileId, ctx.userId)
  if (!file || file.status !== 'uploaded') throw notFound('File not found.')

  if (file.visibility === 'public') return { url: cdnUrl(file.object_key), expiresAt: null as string | null }
  if (!storageIsConfigured()) throw gatewayError("File storage isn't set up yet.")
  const signed = storage.presignGet({ bucket: file.bucket as Bucket, key: file.object_key, expiresInSeconds: GET_URL_TTL_SECONDS })
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() }
}
