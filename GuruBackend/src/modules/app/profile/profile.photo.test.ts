import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { closeRedis } from '../../../lib/redis.js'
import { localStorageProvider } from '../../../lib/storage.js'
import { APP, bearer, createParent, deleteParent, loadMasters, pathOf, presignFile, SAMPLE_BYTES, uploadFile } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'

const app = createApp()

let m: Masters
const parents: TestParent[] = []

async function newParent() {
  const p = await createParent(m)
  parents.push(p)
  return p
}

const get = (p: TestParent) => request(app).get(`${APP}/parent/profile`).set(bearer(p))
const patch = (p: TestParent, body: Record<string, unknown>, version: string) =>
  request(app).patch(`${APP}/parent/profile`).set(bearer(p)).set('If-Match', version).send(body)

async function avatar(p: TestParent, mimeType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg') {
  const { fileId, confirmed } = await uploadFile(app, p, { mimeType })
  return { fileId, publicUrl: confirmed.body.data.publicUrl as string }
}

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  for (const p of parents) {
    await db.updateTable('app_users').set({ profile_photo_file_id: null }).where('id', '=', p.userId).execute()
    await db.deleteFrom('files').where('uploaded_by_id', '=', p.userId).execute()
    await deleteParent(p)
  }
  await closeRedis()
  await pool.end()
})

describe('PATCH /parent/profile — profile photo', () => {
  it('sets the photo from a confirmed avatar upload and shows it in the profile and /me', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    expect(before.photoUrl).toBeNull()
    const { fileId, publicUrl } = await avatar(p)

    const res = await patch(p, { profilePhotoFileId: fileId }, before.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.photoUrl).toBe(publicUrl)
    expect(res.body.data.updatedAt).not.toBe(before.updatedAt)

    expect((await get(p)).body.data.photoUrl).toBe(publicUrl)
    const me = await request(app).get(`${APP}/me`).set(bearer(p))
    expect(me.body.data.photoUrl).toBe(publicUrl)
    expect(me.body.data.photo).toBe(publicUrl)

    // The dev CDN actually serves the image the parent uploaded.
    const image = await request(app).get(new URL(publicUrl).pathname)
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toContain('image/jpeg')

    const user = await db.selectFrom('app_users').select('profile_photo_file_id').where('id', '=', p.userId).executeTakeFirstOrThrow()
    expect(user.profile_photo_file_id).toBe(fileId)
    const audit = await db.selectFrom('audit_logs').select('new_values').where('action', '=', 'app.parent_profile_updated').where('entity_id', '=', p.parentId).executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ changedFields: ['profilePhotoFileId'], photoChanged: true })
  })

  it('can change the photo together with the name in one request', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const { fileId, publicUrl } = await avatar(p, 'image/png')
    const res = await patch(p, { fullName: 'Lakshmi Iyer', profilePhotoFileId: fileId }, before.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ fullName: 'Lakshmi Iyer', photoUrl: publicUrl })
  })

  it('replaces the photo: the old file is soft-deleted and its object removed', async () => {
    const p = await newParent()
    const first = await avatar(p)
    const v1 = (await get(p)).body.data
    await patch(p, { profilePhotoFileId: first.fileId }, v1.updatedAt)
    const firstKey = (await db.selectFrom('files').select('object_key').where('id', '=', first.fileId).executeTakeFirstOrThrow()).object_key
    expect(await localStorageProvider.head('gc-public', firstKey)).not.toBeNull()

    const second = await avatar(p, 'image/webp')
    const v2 = (await get(p)).body.data
    const res = await patch(p, { profilePhotoFileId: second.fileId }, v2.updatedAt)
    expect(res.body.data.photoUrl).toBe(second.publicUrl)

    const old = await db.selectFrom('files').select(['status', 'deleted_at']).where('id', '=', first.fileId).executeTakeFirstOrThrow()
    expect(old.status).toBe('deleted')
    expect(old.deleted_at).not.toBeNull()
    expect(await localStorageProvider.head('gc-public', firstKey)).toBeNull()
    expect((await request(app).get(new URL(first.publicUrl).pathname)).status).toBe(404)
  })

  it('re-sending the current photo does not delete it', async () => {
    const p = await newParent()
    const { fileId, publicUrl } = await avatar(p)
    const v1 = (await get(p)).body.data
    const first = await patch(p, { profilePhotoFileId: fileId }, v1.updatedAt)
    const again = await patch(p, { profilePhotoFileId: fileId }, first.body.data.updatedAt)
    expect(again.status).toBe(200)
    expect(again.body.data.photoUrl).toBe(publicUrl)
    expect((await request(app).get(new URL(publicUrl).pathname)).status).toBe(200)
  })

  it('removes the photo with null, falling back to initials, and deletes the file', async () => {
    const p = await newParent()
    const { fileId, publicUrl } = await avatar(p)
    const v1 = (await get(p)).body.data
    const set = await patch(p, { profilePhotoFileId: fileId }, v1.updatedAt)

    const res = await patch(p, { profilePhotoFileId: null }, set.body.data.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.photoUrl).toBeNull()
    expect((await get(p)).body.data.photoUrl).toBeNull()
    expect((await request(app).get(`${APP}/me`).set(bearer(p))).body.data.photoUrl).toBeNull()
    const file = await db.selectFrom('files').select('status').where('id', '=', fileId).executeTakeFirstOrThrow()
    expect(file.status).toBe('deleted')
    expect((await request(app).get(new URL(publicUrl).pathname)).status).toBe(404)
  })

  it('removing a photo when there is none is harmless', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const res = await patch(p, { profilePhotoFileId: null }, before.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data.photoUrl).toBeNull()
  })

  it("rejects a file that isn't a finished avatar upload of this user (VALIDATION_FAILED) and changes nothing", async () => {
    const p = await newParent()
    const other = await newParent()
    const before = (await get(p)).body.data
    const message = "That photo didn't upload. Try again."

    const unknown = await patch(p, { profilePhotoFileId: randomUUID() }, before.updatedAt)
    expect(unknown.status).toBe(422)
    expect(unknown.body.error.details).toEqual([{ path: 'profilePhotoFileId', message }])

    const pending = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: 100 })
    expect((await patch(p, { profilePhotoFileId: pending.body.data.fileId }, before.updatedAt)).status).toBe(422)

    const theirs = await uploadFile(app, other)
    expect((await patch(p, { profilePhotoFileId: theirs.fileId }, before.updatedAt)).status).toBe(422)

    const document = await uploadFile(app, p, { purpose: 'teacher_document', mimeType: 'application/pdf' })
    expect((await patch(p, { profilePhotoFileId: document.fileId }, before.updatedAt)).status).toBe(422)

    const otherPurpose = await uploadFile(app, p, { purpose: 'teacher_photo' })
    expect((await patch(p, { profilePhotoFileId: otherPurpose.fileId }, before.updatedAt)).status).toBe(422)

    const deleted = await avatar(p)
    await db.updateTable('files').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', deleted.fileId).execute()
    expect((await patch(p, { profilePhotoFileId: deleted.fileId }, before.updatedAt)).status).toBe(422)

    expect((await patch(p, { profilePhotoFileId: 'not-a-uuid' }, before.updatedAt)).status).toBe(422)

    const after = (await get(p)).body.data
    expect(after.photoUrl).toBeNull()
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it("does not accept another user's avatar even if the file id leaks", async () => {
    const owner = await newParent()
    const thief = await newParent()
    const { fileId } = await avatar(owner)
    const before = (await get(thief)).body.data
    expect((await patch(thief, { profilePhotoFileId: fileId }, before.updatedAt)).status).toBe(422)
  })

  it('returns 409 VERSION_CONFLICT for a stale If-Match even when only the photo changes', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    await patch(p, { fullName: 'Someone Else' }, before.updatedAt)
    const { fileId } = await avatar(p)
    const stale = await patch(p, { profilePhotoFileId: fileId }, before.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
    expect((await get(p)).body.data.photoUrl).toBeNull()
  })

  it('leaves the photo unchanged when another field in the same request is invalid', async () => {
    const p = await newParent()
    const before = (await get(p)).body.data
    const { fileId } = await avatar(p)
    const res = await patch(p, { profilePhotoFileId: fileId, cityId: randomUUID() }, before.updatedAt)
    expect(res.status).toBe(422)
    expect((await get(p)).body.data.photoUrl).toBeNull()
    const file = await db.selectFrom('files').select('status').where('id', '=', fileId).executeTakeFirstOrThrow()
    expect(file.status).toBe('uploaded') // still usable for the retry
  })

  it('works end to end using only the API: presign, PUT to the signed URL, confirm, PATCH', async () => {
    const p = await newParent()
    const bytes = SAMPLE_BYTES['image/jpeg'](300)
    const presigned = await presignFile(app, p, { purpose: 'avatar', mimeType: 'image/jpeg', sizeBytes: bytes.length, fileName: 'IMG_0001.jpg' })
    await request(app).put(pathOf(presigned.body.data.uploadUrl)).set('Content-Type', 'image/jpeg').send(bytes)
    const confirmed = await request(app).post(`${APP}/uploads/${presigned.body.data.fileId}/confirm`).set(bearer(p))
    const version = (await get(p)).body.data.updatedAt
    const res = await patch(p, { profilePhotoFileId: confirmed.body.data.fileId }, version)
    expect(res.status).toBe(200)
    const served = await request(app).get(new URL(res.body.data.photoUrl).pathname)
    expect(Buffer.from(served.body).equals(bytes)).toBe(true)
  })
})
