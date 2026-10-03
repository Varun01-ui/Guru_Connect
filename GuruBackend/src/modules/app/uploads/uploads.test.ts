import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { env } from '../../../config/env.js'
import { db, pool } from '../../../db/index.js'
import { closeRedis } from '../../../lib/redis.js'
import { localStorageProvider, signStorageRequest } from '../../../lib/storage.js'
import { APP, bearer, createParent, deleteParent, loadMasters, pathOf, presignFile, SAMPLE_BYTES, uploadFile } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'
import { cleanupPendingUploads } from './uploads.jobs.js'

const app = createApp()

let m: Masters
const parents: TestParent[] = []

async function newParent(overrides: Parameters<typeof createParent>[1] = {}) {
  const p = await createParent(m, overrides)
  parents.push(p)
  return p
}

const MB = 1024 * 1024

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  for (const p of parents) {
    await db.deleteFrom('files').where('uploaded_by_id', '=', p.userId).execute()
    await deleteParent(p)
  }
  await closeRedis()
  await pool.end()
})

describe('POST /uploads/presign', () => {
  it('requires a bearer token', async () => {
    const res = await request(app).post(`${APP}/uploads/presign`).send({})
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('creates a pending file and returns a short-lived signed PUT URL', async () => {
    const p = await newParent()
    const res = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 845213, fileName: 'me.jpg' })

    expect(res.status).toBe(201)
    const data = res.body.data
    expect(data).toMatchObject({ fileId: expect.any(String), method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } })
    expect(data.uploadUrl).toContain('/api/v1/app/dev-storage/gc-public/avatars/')
    expect(data.uploadUrl).toContain('sig=')
    const minutes = (new Date(data.expiresAt).getTime() - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(9)
    expect(minutes).toBeLessThanOrEqual(10)

    const file = await db.selectFrom('files').selectAll().where('id', '=', data.fileId).executeTakeFirstOrThrow()
    expect(file).toMatchObject({
      storage_provider: 'r2',
      bucket: 'gc-public',
      mime_type: 'image/jpeg',
      visibility: 'public',
      purpose: 'avatar',
      uploaded_by_type: 'app_user',
      uploaded_by_id: p.userId,
      status: 'pending',
      original_name: 'me.jpg',
    })
    expect(Number(file.size_bytes)).toBe(845213)
    expect(file.object_key).toMatch(new RegExp(`^avatars/${p.userId}/[0-9a-f-]{36}\\.jpg$`))
  })

  it('puts private purposes in the private bucket', async () => {
    const p = await newParent()
    const res = await presignFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf', sizeBytes: 5000, fileName: 'aadhaar.pdf' })
    expect(res.status).toBe(201)
    expect(res.body.data.uploadUrl).toContain('/dev-storage/gc-private/teacher-docs/')
    const file = await db.selectFrom('files').select(['bucket', 'visibility']).where('id', '=', res.body.data.fileId).executeTakeFirstOrThrow()
    expect(file).toEqual({ bucket: 'gc-private', visibility: 'private' })
  })

  it('never lets the client-supplied file name reach the object key, and sanitises it', async () => {
    const p = await newParent()
    const res = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/png', sizeBytes: 100, fileName: '../../etc/passwd.png' })
    expect(res.status).toBe(201)
    expect(res.body.data.uploadUrl).not.toContain('passwd')
    const file = await db.selectFrom('files').select(['original_name', 'object_key']).where('id', '=', res.body.data.fileId).executeTakeFirstOrThrow()
    expect(file.original_name).not.toContain('/')
    expect(file.object_key).not.toContain('..')
  })

  it('works for any signed-in role, not only parents', async () => {
    const teacher = await newParent({ role: 'teacher' })
    const res = await presignFile(app, teacher, { purpose: 'teacher_photo', mimeType: 'image/webp', sizeBytes: 1000 })
    expect(res.status).toBe(201)
  })

  it('enforces the allowed MIME types per purpose (FILE_TYPE_NOT_ALLOWED)', async () => {
    const p = await newParent()
    for (const [purpose, mimeType] of [
      ['avatar', 'application/pdf'],
      ['avatar', 'image/gif'],
      ['avatar', 'image/svg+xml'],
      ['teacher_document', 'image/webp'],
      ['teacher_document', 'text/html'],
    ] as const) {
      const res = await presignFile(app, p, { purpose, mimeType, sizeBytes: 1000 })
      expect(res.status, `${purpose} ${mimeType}`).toBe(415)
      expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    }
    expect((await presignFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf', sizeBytes: 1000 })).status).toBe(201)
    expect((await presignFile(app, p, { purpose: 'avatar', mimeType: 'IMAGE/JPEG', sizeBytes: 1000 })).status).toBe(201)
  })

  it('enforces the size limit per purpose (FILE_TOO_LARGE)', async () => {
    const p = await newParent()
    const tooBigAvatar = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 5 * MB + 1 })
    expect(tooBigAvatar.status).toBe(413)
    expect(tooBigAvatar.body.error.code).toBe('FILE_TOO_LARGE')
    expect(tooBigAvatar.body.error.details).toEqual({ maxBytes: 5 * MB })

    expect((await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 5 * MB })).status).toBe(201)
    expect((await presignFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf', sizeBytes: 10 * MB })).status).toBe(201)
    expect((await presignFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf', sizeBytes: 10 * MB + 1 })).status).toBe(413)
  })

  it('validates the request body (VALIDATION_FAILED)', async () => {
    const p = await newParent()
    const good = { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100, fileName: 'a.jpg' }
    for (const bad of [
      { ...good, purpose: 'bogus' },
      { ...good, sizeBytes: 0 },
      { ...good, sizeBytes: -5 },
      { ...good, sizeBytes: 1.5 },
      { ...good, sizeBytes: '100' },
      { ...good, fileName: '' },
      { ...good, fileName: 'x'.repeat(256) },
      { ...good, mimeType: '' },
      { purpose: 'avatar' },
    ]) {
      const res = await request(app).post(`${APP}/uploads/presign`).set(bearer(p)).send(bad)
      expect(res.status, JSON.stringify(bad)).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('allows at most 20 pending uploads per user (LIMIT_REACHED)', async () => {
    const p = await newParent()
    const other = await newParent()
    for (let i = 0; i < 20; i++) expect((await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })).status).toBe(201)

    const res = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('LIMIT_REACHED')
    expect(res.body.error.message).toBe('Finish or cancel your other uploads first.')
    expect(res.body.error.details).toEqual({ reason: 'max_pending_uploads', limit: 20, current: 20 })

    expect((await presignFile(app, other, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })).status).toBe(201)
  })
})

describe('PUT to the signed URL (dev storage)', () => {
  async function presigned(p: TestParent, mime = 'image/jpeg', bytes = SAMPLE_BYTES['image/jpeg'](100)) {
    const res = await presignFile(app, p, { purpose: 'avatar', mimeType: mime, sizeBytes: bytes.length })
    return { path: pathOf(res.body.data.uploadUrl), fileId: res.body.data.fileId as string, bytes, mime }
  }

  it('stores the object when signature, Content-Type and length all match', async () => {
    const p = await newParent()
    const u = await presigned(p)
    const res = await request(app).put(u.path).set('Content-Type', u.mime).send(u.bytes)
    expect(res.status).toBe(200)

    const file = await db.selectFrom('files').select(['bucket', 'object_key']).where('id', '=', u.fileId).executeTakeFirstOrThrow()
    expect(await localStorageProvider.head('gc-public', file.object_key)).toEqual({ size: u.bytes.length, contentType: 'image/jpeg' })
  })

  it('rejects a bad, missing or tampered signature (403)', async () => {
    const p = await newParent()
    const u = await presigned(p)
    const url = new URL(`http://x${u.path}`)

    const badSig = new URL(url); badSig.searchParams.set('sig', '0'.repeat(64))
    expect((await request(app).put(`${badSig.pathname}${badSig.search}`).set('Content-Type', u.mime).send(u.bytes)).status).toBe(403)

    const noSig = new URL(url); noSig.searchParams.delete('sig')
    expect((await request(app).put(`${noSig.pathname}${noSig.search}`).set('Content-Type', u.mime).send(u.bytes)).status).toBe(403)

    const biggerSize = new URL(url); biggerSize.searchParams.set('size', String(u.bytes.length + 1000))
    expect((await request(app).put(`${biggerSize.pathname}${biggerSize.search}`).set('Content-Type', u.mime).send(Buffer.alloc(u.bytes.length + 1000, 1))).status).toBe(403)

    const otherKey = url.pathname.replace(/[0-9a-f-]{36}\.jpg$/, `${randomUUID()}.jpg`)
    expect((await request(app).put(`${otherKey}${url.search}`).set('Content-Type', u.mime).send(u.bytes)).status).toBe(403)
  })

  it('rejects an expired URL (403)', async () => {
    const p = await newParent()
    const u = await presigned(p)
    const url = new URL(`http://x${u.path}`)
    const key = url.pathname.replace('/api/v1/app/dev-storage/gc-public/', '')
    const expires = Math.floor(Date.now() / 1000) - 10
    const sig = signStorageRequest({ method: 'PUT', bucket: 'gc-public', key, expires, contentType: 'image/jpeg', sizeBytes: u.bytes.length })
    const expired = `${url.pathname}?expires=${expires}&ct=image%2Fjpeg&size=${u.bytes.length}&sig=${sig}`
    const res = await request(app).put(expired).set('Content-Type', 'image/jpeg').send(u.bytes)
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('This link has expired.')
  })

  it('rejects a different Content-Type or a different length than presigned (403)', async () => {
    const p = await newParent()
    const u = await presigned(p)
    expect((await request(app).put(u.path).set('Content-Type', 'text/html').send(u.bytes)).status).toBe(403)
    expect((await request(app).put(u.path).set('Content-Type', u.mime).send(Buffer.concat([u.bytes, Buffer.from('x')]))).status).toBe(403)
    expect((await request(app).put(u.path).set('Content-Type', u.mime).send(u.bytes.subarray(0, 10))).status).toBe(403)
  })

  it('refuses unknown buckets and path traversal (404)', async () => {
    const p = await newParent()
    const u = await presigned(p)
    const search = u.path.slice(u.path.indexOf('?'))
    expect((await request(app).put(`/api/v1/app/dev-storage/somewhere-else/avatars/x.jpg${search}`).set('Content-Type', u.mime).send(u.bytes)).status).toBe(404)
    expect((await request(app).put(`/api/v1/app/dev-storage/gc-public/avatars/%2e%2e/%2e%2e/x.jpg${search}`).set('Content-Type', u.mime).send(u.bytes)).status).toBe(404)
  })
})

describe('POST /uploads/:fileId/confirm', () => {
  it('activates a verified upload and returns the CDN URL for public purposes', async () => {
    const p = await newParent()
    const { confirmed, fileId } = await uploadFile(app, p)

    expect(confirmed.status).toBe(200)
    const file = await db.selectFrom('files').select(['status', 'object_key']).where('id', '=', fileId).executeTakeFirstOrThrow()
    expect(confirmed.body.data).toEqual({ fileId, status: 'active', publicUrl: `${env.CDN_BASE_URL}/${file.object_key}` })
    expect(file.status).toBe('uploaded')
  })

  it('returns publicUrl null for private purposes', async () => {
    const p = await newParent()
    const { confirmed } = await uploadFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf' })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.data.publicUrl).toBeNull()
  })

  it('accepts png, webp and pdf uploads', async () => {
    const p = await newParent()
    for (const mimeType of ['image/png', 'image/webp'] as const) expect((await uploadFile(app, p, { mimeType })).confirmed.status).toBe(200)
    expect((await uploadFile(app, p, { purpose: 'support_attachment', mimeType: 'application/pdf' })).confirmed.status).toBe(200)
  })

  it('is idempotent and writes one audit row without the file name', async () => {
    const p = await newParent()
    const { confirmed, fileId } = await uploadFile(app, p, { fileName: 'aadhaar-front-1234.jpg' })
    const again = await request(app).post(`${APP}/uploads/${fileId}/confirm`).set(bearer(p))
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual(confirmed.body.data)

    const rows = await db.selectFrom('audit_logs').select(['new_values', 'actor_id']).where('action', '=', 'app.file_uploaded').where('entity_id', '=', fileId).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_id: p.userId, new_values: { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 200 } })
    expect(JSON.stringify(rows[0])).not.toContain('aadhaar')
  })

  it("fails when the object was never uploaded, and leaves the file pending so the PUT can be retried", async () => {
    const p = await newParent()
    const presigned = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })
    const res = await request(app).post(`${APP}/uploads/${presigned.body.data.fileId}/confirm`).set(bearer(p))
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    const file = await db.selectFrom('files').select('status').where('id', '=', presigned.body.data.fileId).executeTakeFirstOrThrow()
    expect(file.status).toBe('pending')
  })

  it('treats another user\'s file, an unknown id and a deleted file as not found (404), and rejects malformed ids (422)', async () => {
    const owner = await newParent()
    const other = await newParent()
    const { fileId } = await uploadFile(app, owner)

    expect((await request(app).post(`${APP}/uploads/${fileId}/confirm`).set(bearer(other))).status).toBe(404)
    expect((await request(app).post(`${APP}/uploads/${randomUUID()}/confirm`).set(bearer(owner))).status).toBe(404)
    expect((await request(app).post(`${APP}/uploads/not-a-uuid/confirm`).set(bearer(owner))).status).toBe(422)
    expect((await request(app).post(`${APP}/uploads/${fileId}/confirm`)).status).toBe(401)

    await db.updateTable('files').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', fileId).execute()
    expect((await request(app).post(`${APP}/uploads/${fileId}/confirm`).set(bearer(owner))).status).toBe(404)
  })

  it('rejects and deletes an object whose bytes are not the declared type (FILE_TYPE_NOT_ALLOWED)', async () => {
    const p = await newParent()
    // Declared JPEG, but the bytes are a PDF — e.g. a renamed file, or HTML pretending to be an image.
    const bytes = SAMPLE_BYTES['application/pdf'](100)
    const presigned = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: bytes.length })
    await request(app).put(pathOf(presigned.body.data.uploadUrl)).set('Content-Type', 'image/jpeg').send(bytes)

    const res = await request(app).post(`${APP}/uploads/${presigned.body.data.fileId}/confirm`).set(bearer(p))
    expect(res.status).toBe(415)
    expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED')

    const file = await db.selectFrom('files').select(['status', 'deleted_at', 'bucket', 'object_key']).where('id', '=', presigned.body.data.fileId).executeTakeFirstOrThrow()
    expect(file.status).toBe('deleted')
    expect(file.deleted_at).not.toBeNull()
    expect(await localStorageProvider.head('gc-public', file.object_key)).toBeNull()
  })

  it('rejects an object stored with a different Content-Type than promised (FILE_TYPE_NOT_ALLOWED)', async () => {
    const p = await newParent()
    const bytes = SAMPLE_BYTES['image/jpeg'](100)
    const presigned = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: bytes.length })
    const file = await db.selectFrom('files').select('object_key').where('id', '=', presigned.body.data.fileId).executeTakeFirstOrThrow()
    await localStorageProvider.write('gc-public', file.object_key, bytes, 'text/html')

    const res = await request(app).post(`${APP}/uploads/${presigned.body.data.fileId}/confirm`).set(bearer(p))
    expect(res.status).toBe(415)
  })

  it('rejects an object larger than declared (FILE_TOO_LARGE, deleted) and reports a smaller one as incomplete (422, kept)', async () => {
    const p = await newParent()
    const declared = SAMPLE_BYTES['image/jpeg'](100)

    const big = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: declared.length })
    const bigKey = (await db.selectFrom('files').select('object_key').where('id', '=', big.body.data.fileId).executeTakeFirstOrThrow()).object_key
    await localStorageProvider.write('gc-public', bigKey, SAMPLE_BYTES['image/jpeg'](500), 'image/jpeg')
    const tooBig = await request(app).post(`${APP}/uploads/${big.body.data.fileId}/confirm`).set(bearer(p))
    expect(tooBig.status).toBe(413)
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE')
    expect(await localStorageProvider.head('gc-public', bigKey)).toBeNull()

    const small = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: declared.length })
    const smallKey = (await db.selectFrom('files').select('object_key').where('id', '=', small.body.data.fileId).executeTakeFirstOrThrow()).object_key
    await localStorageProvider.write('gc-public', smallKey, SAMPLE_BYTES['image/jpeg'](50), 'image/jpeg')
    const incomplete = await request(app).post(`${APP}/uploads/${small.body.data.fileId}/confirm`).set(bearer(p))
    expect(incomplete.status).toBe(422)
    expect((await db.selectFrom('files').select('status').where('id', '=', small.body.data.fileId).executeTakeFirstOrThrow()).status).toBe('pending')
  })
})

describe('GET /files/:id/url', () => {
  it('requires a bearer token', async () => {
    expect((await request(app).get(`${APP}/files/${randomUUID()}/url`)).status).toBe(401)
  })

  it('returns the CDN URL for a public file, and the dev CDN serves the bytes cross-origin', async () => {
    const p = await newParent()
    const bytes = SAMPLE_BYTES['image/png'](120)
    const { fileId } = await uploadFile(app, p, { mimeType: 'image/png', bytes })
    const res = await request(app).get(`${APP}/files/${fileId}/url`).set(bearer(p))

    expect(res.status).toBe(200)
    expect(res.body.data.expiresAt).toBeNull()
    expect(res.body.data.url).toMatch(new RegExp(`^${env.CDN_BASE_URL}/avatars/${p.userId}/`))

    const cdn = await request(app).get(new URL(res.body.data.url).pathname)
    expect(cdn.status).toBe(200)
    expect(cdn.headers['content-type']).toContain('image/png')
    expect(cdn.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(cdn.headers['cache-control']).toContain('public')
    expect(Buffer.from(cdn.body).equals(bytes)).toBe(true)
  })

  it('returns a 60-second signed URL for a private file that serves the bytes once', async () => {
    const p = await newParent()
    const bytes = SAMPLE_BYTES['application/pdf'](300)
    const { fileId } = await uploadFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf', bytes })
    const res = await request(app).get(`${APP}/files/${fileId}/url`).set(bearer(p))

    expect(res.status).toBe(200)
    const seconds = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 1000
    expect(seconds).toBeGreaterThan(55)
    expect(seconds).toBeLessThanOrEqual(60)

    const download = await request(app).get(pathOf(res.body.data.url))
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toContain('application/pdf')
    expect(download.headers['cache-control']).toContain('no-store')
    expect(Buffer.from(download.body).equals(bytes)).toBe(true)

    const tampered = new URL(res.body.data.url)
    tampered.searchParams.set('sig', '0'.repeat(64))
    expect((await request(app).get(`${tampered.pathname}${tampered.search}`)).status).toBe(403)
    expect((await request(app).get(new URL(res.body.data.url).pathname)).status).toBe(403) // unsigned
  })

  it('never serves private objects through the public CDN route', async () => {
    const p = await newParent()
    const { fileId } = await uploadFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf' })
    const key = (await db.selectFrom('files').select('object_key').where('id', '=', fileId).executeTakeFirstOrThrow()).object_key
    expect((await request(app).get(`/cdn/${key}`)).status).toBe(404)
    expect((await request(app).get('/cdn/%2e%2e/%2e%2e/package.json')).status).toBe(404)
  })

  it("returns 404 for someone else's file, a pending file, an unknown id, and 422 for a malformed id", async () => {
    const owner = await newParent()
    const other = await newParent()
    const { fileId } = await uploadFile(app, owner)
    const pending = await presignFile(app, owner, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })

    expect((await request(app).get(`${APP}/files/${fileId}/url`).set(bearer(other))).status).toBe(404)
    expect((await request(app).get(`${APP}/files/${pending.body.data.fileId}/url`).set(bearer(owner))).status).toBe(404)
    expect((await request(app).get(`${APP}/files/${randomUUID()}/url`).set(bearer(owner))).status).toBe(404)
    expect((await request(app).get(`${APP}/files/nope/url`).set(bearer(owner))).status).toBe(422)
  })
})

describe('cleanupPendingUploads job', () => {
  it('removes pending uploads older than 24 hours (object and row) and keeps everything else', async () => {
    const p = await newParent()
    const bytes = SAMPLE_BYTES['image/jpeg'](100)

    const stalePresign = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: bytes.length })
    await request(app).put(pathOf(stalePresign.body.data.uploadUrl)).set('Content-Type', 'image/jpeg').send(bytes)
    const staleKey = (await db.selectFrom('files').select('object_key').where('id', '=', stalePresign.body.data.fileId).executeTakeFirstOrThrow()).object_key
    await db.updateTable('files').set({ created_at: new Date(Date.now() - 25 * 3_600_000) }).where('id', '=', stalePresign.body.data.fileId).execute()

    const fresh = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })
    const confirmed = await uploadFile(app, p)
    await db.updateTable('files').set({ created_at: new Date(Date.now() - 48 * 3_600_000) }).where('id', '=', confirmed.fileId).execute() // old, but confirmed

    expect(await cleanupPendingUploads()).toBeGreaterThanOrEqual(1)

    expect(await db.selectFrom('files').select('id').where('id', '=', stalePresign.body.data.fileId).executeTakeFirst()).toBeUndefined()
    expect(await localStorageProvider.head('gc-public', staleKey)).toBeNull()
    expect(await db.selectFrom('files').select('id').where('id', '=', fresh.body.data.fileId).executeTakeFirst()).toBeDefined()
    expect(await db.selectFrom('files').select('id').where('id', '=', confirmed.fileId).executeTakeFirst()).toBeDefined()
  })
})
