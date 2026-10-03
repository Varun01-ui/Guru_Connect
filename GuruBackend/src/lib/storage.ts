import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.js'

// M00 file storage behind one interface. There is no Cloudflare R2 / S3 account yet, so the only driver is a
// local-disk one whose "presigned" URLs are HMAC-signed links back to this API (modules/app/uploads/devStorage.routes.ts).
// A real R2 driver implements the same interface; nothing above this file needs to change.
export const BUCKETS = { public: 'gc-public', private: 'gc-private' } as const
export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS]

export type StoredObject = { size: number; contentType: string }

export interface StorageProvider {
  presignPut(input: { bucket: Bucket; key: string; contentType: string; sizeBytes: number; expiresInSeconds: number }): {
    url: string
    headers: Record<string, string>
    expiresAt: Date
  }
  presignGet(input: { bucket: Bucket; key: string; expiresInSeconds: number }): { url: string; expiresAt: Date }
  head(bucket: Bucket, key: string): Promise<StoredObject | null>
  peek(bucket: Bucket, key: string, bytes: number): Promise<Buffer | null>
  delete(bucket: Bucket, key: string): Promise<void>
}

// Keys are generated server-side, but the local driver also receives them from URLs, so it re-validates hard.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/
export function isSafeKey(key: string): boolean {
  return SAFE_KEY.test(key) && !key.split('/').some((part) => part === '' || part === '.' || part === '..')
}

// ---------- content sniffing (never trust the client-declared Content-Type alone) ----------

export function sniffMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  return null
}

// ---------- local-disk driver ----------

export function signStorageRequest(input: { method: 'PUT' | 'GET'; bucket: string; key: string; expires: number; contentType?: string; sizeBytes?: number }): string {
  const payload = [input.method, input.bucket, input.key, input.expires, input.contentType ?? '', input.sizeBytes ?? ''].join('\n')
  return createHmac('sha256', env.STORAGE_SIGNING_SECRET).update(payload).digest('hex')
}

export function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

const root = () => path.resolve(env.STORAGE_LOCAL_DIR)

function objectPath(bucket: Bucket, key: string): string {
  if (!isSafeKey(key)) throw new Error('Unsafe storage key')
  const resolved = path.resolve(root(), bucket, key)
  if (!resolved.startsWith(path.resolve(root(), bucket) + path.sep)) throw new Error('Unsafe storage key')
  return resolved
}

const metaPath = (file: string) => `${file}.meta.json`

export const localStorageProvider: StorageProvider & {
  write(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void>
  read(bucket: Bucket, key: string): Promise<{ body: Buffer; contentType: string } | null>
} = {
  presignPut({ bucket, key, contentType, sizeBytes, expiresInSeconds }) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds
    const sig = signStorageRequest({ method: 'PUT', bucket, key, expires, contentType, sizeBytes })
    const query = new URLSearchParams({ expires: String(expires), ct: contentType, size: String(sizeBytes), sig })
    return {
      url: `${env.API_PUBLIC_URL}/api/v1/app/dev-storage/${bucket}/${key}?${query}`,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(expires * 1000),
    }
  },

  presignGet({ bucket, key, expiresInSeconds }) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds
    const sig = signStorageRequest({ method: 'GET', bucket, key, expires })
    const query = new URLSearchParams({ expires: String(expires), sig })
    return { url: `${env.API_PUBLIC_URL}/api/v1/app/dev-storage/${bucket}/${key}?${query}`, expiresAt: new Date(expires * 1000) }
  },

  async write(bucket, key, body, contentType) {
    const file = objectPath(bucket, key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body)
    await writeFile(metaPath(file), JSON.stringify({ contentType }))
  },

  async read(bucket, key) {
    const file = objectPath(bucket, key)
    try {
      const [body, meta] = await Promise.all([readFile(file), readFile(metaPath(file), 'utf8')])
      return { body, contentType: (JSON.parse(meta) as { contentType: string }).contentType }
    } catch {
      return null
    }
  },

  async head(bucket, key) {
    const file = objectPath(bucket, key)
    try {
      const [info, meta] = await Promise.all([stat(file), readFile(metaPath(file), 'utf8')])
      return { size: info.size, contentType: (JSON.parse(meta) as { contentType: string }).contentType }
    } catch {
      return null
    }
  },

  async peek(bucket, key, bytes) {
    try {
      const handle = await open(objectPath(bucket, key), 'r')
      try {
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  },

  async delete(bucket, key) {
    const file = objectPath(bucket, key)
    await rm(file, { force: true })
    await rm(metaPath(file), { force: true })
  },
}

// The driver the app uses. Swap this single binding for an R2 implementation once credentials exist.
export const storage: StorageProvider = localStorageProvider

// Local driver routes are dev-only; production must use a real driver.
export const storageIsConfigured = () => env.NODE_ENV !== 'production'
