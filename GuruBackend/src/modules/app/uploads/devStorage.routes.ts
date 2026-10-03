import { Router } from 'express'
import type { Request } from 'express'
import { ApiError, fileTooLarge, forbidden, notFound, validationFailed } from '../../../lib/errors.js'
import { BUCKETS, isSafeKey, localStorageProvider, signatureMatches, signStorageRequest } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'

// Development stand-in for R2's presigned endpoints. The URLs handed out by lib/storage.ts point here; each carries an
// HMAC signature, an expiry and (for PUT) the exact Content-Type and byte length that were promised at presign time —
// the same guarantees an R2 presigned PUT gives. Only mounted outside production.
export const devStorageRouter = Router()
// The dev "CDN": serves the public bucket only, mounted at /cdn in app.ts.
export const devCdnRouter = Router()

function bucketAndKey(req: Request): { bucket: Bucket; key: string } {
  const bucket = req.params.bucket as Bucket
  const key = (req.params as Record<string, string>)[0] ?? ''
  if (!Object.values(BUCKETS).includes(bucket) || !isSafeKey(key)) throw notFound('Not found.')
  return { bucket, key }
}

function verify(req: Request, method: 'PUT' | 'GET', bucket: string, key: string, extra: { contentType?: string; sizeBytes?: number } = {}) {
  const expires = Number(req.query.expires)
  const sig = String(req.query.sig ?? '')
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) throw forbidden('This link has expired.')
  const expected = signStorageRequest({ method, bucket, key, expires, ...extra })
  if (!signatureMatches(expected, sig)) throw forbidden('Invalid signature.')
}

async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) throw fileTooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

devStorageRouter.put('/dev-storage/:bucket/*', async (req, res) => {
  const { bucket, key } = bucketAndKey(req)
  const contentType = String(req.query.ct ?? '')
  const sizeBytes = Number(req.query.size)
  verify(req, 'PUT', bucket, key, { contentType, sizeBytes })

  // Content-Type and Content-Length are fixed by the presign (as with a real R2 presigned PUT).
  if ((req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== contentType) throw forbidden('Content-Type does not match the upload URL.')
  if (Number(req.header('content-length')) !== sizeBytes) throw forbidden('Content-Length does not match the upload URL.')

  const body = await readBody(req, sizeBytes)
  if (body.length !== sizeBytes) throw validationFailed(undefined, 'The upload was incomplete.')
  await localStorageProvider.write(bucket, key, body, contentType)
  res.status(200).end()
})

devStorageRouter.get('/dev-storage/:bucket/*', async (req, res) => {
  const { bucket, key } = bucketAndKey(req)
  verify(req, 'GET', bucket, key)
  const object = await localStorageProvider.read(bucket, key)
  if (!object) throw new ApiError(404, 'NOT_FOUND', 'Not found.')
  res.setHeader('Content-Type', object.contentType)
  res.setHeader('Cache-Control', 'private, no-store')
  res.status(200).send(object.body)
})

devCdnRouter.get('/*', async (req, res) => {
  const key = (req.params as Record<string, string>)[0] ?? ''
  if (!isSafeKey(key)) throw notFound('Not found.')
  const object = await localStorageProvider.read(BUCKETS.public, key)
  if (!object) throw notFound('Not found.')
  res.setHeader('Content-Type', object.contentType)
  res.setHeader('Cache-Control', 'public, max-age=3600')
  // helmet's default same-origin policy would stop the app (a different origin) from loading its own images.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.status(200).send(object.body)
})
