import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db } from '../../db/index.js'
import { API, adminUpload, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'
import { pngOf } from '../../test/images.js'

const app = createApp()
const EMAIL_PREFIX = 'aup-test'

let ops: TestAdmin // banners.manage
let finance: TestAdmin // no banner permission
let stranger: TestAdmin

const presign = (a: { token: string }, body: object) => request(app).post(`${API}/uploads/presign`).set(authed(a.token)).send(body)

beforeAll(async () => {
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  finance = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  stranger = await createAdminWithToken({ emailPrefix: EMAIL_PREFIX })
})

afterAll(async () => {
  await purgeRbacFixtures(EMAIL_PREFIX)
})

describe('POST /uploads/presign (admin)', () => {
  it('needs a signed-in admin', async () => {
    expect((await request(app).post(`${API}/uploads/presign`).send({})).status).toBe(401)
    expect((await request(app).post(`${API}/uploads/${randomUUID()}/confirm`)).status).toBe(401)
  })

  it('hands any admin a presigned PUT for an avatar and records it as theirs', async () => {
    const res = await presign(stranger, { purpose: 'admin_avatar', mimeType: 'image/png', sizeBytes: 1000, fileName: 'me.png' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.uploadUrl).toContain('/gc-public/admin-avatars/')
    const file = await db.selectFrom('files').selectAll().where('id', '=', res.body.data.fileId).executeTakeFirstOrThrow()
    expect(file).toMatchObject({ uploaded_by_type: 'admin', uploaded_by_id: stranger.id, purpose: 'admin_avatar', status: 'pending', visibility: 'public' })
  })

  it('does not offer the mobile purposes or unknown ones (422)', async () => {
    for (const purpose of ['avatar', 'teacher_document', 'nonsense']) {
      expect((await presign(ops, { purpose, mimeType: 'image/png', sizeBytes: 100, fileName: 'a.png' })).status, purpose).toBe(422)
    }
  })

  it('checks type (415) and size (413) per purpose', async () => {
    const type = await presign(ops, { purpose: 'admin_avatar', mimeType: 'application/pdf', sizeBytes: 100, fileName: 'a.pdf' })
    expect(type.status).toBe(415)
    expect(type.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    const avatar = await presign(ops, { purpose: 'admin_avatar', mimeType: 'image/png', sizeBytes: 3 * 1024 * 1024, fileName: 'a.png' })
    expect(avatar.status).toBe(413)
    const banner = await presign(ops, { purpose: 'banner_image', mimeType: 'image/png', sizeBytes: 500 * 1024 + 1, fileName: 'b.png' })
    expect(banner.status).toBe(413)
    expect(banner.body.error.code).toBe('FILE_TOO_LARGE')
  })

  it('keeps banner images for admins who may manage banners (403 otherwise)', async () => {
    const body = { purpose: 'banner_image', mimeType: 'image/png', sizeBytes: 1000, fileName: 'b.png' }
    const denied = await presign(finance, body)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('FORBIDDEN')
    expect((await presign(ops, body)).status).toBe(201)
  })

  it('rejects a malformed body', async () => {
    expect((await presign(ops, { purpose: 'admin_avatar', mimeType: 'image/png', sizeBytes: 0, fileName: 'a.png' })).status).toBe(422)
    expect((await presign(ops, { purpose: 'admin_avatar', sizeBytes: 10, fileName: 'a.png' })).status).toBe(422)
  })
})

describe('POST /uploads/:fileId/confirm (admin)', () => {
  it('verifies the stored object and reports the public url', async () => {
    const { presigned, put, confirmed } = await adminUpload(app, ops, { bytes: pngOf(100, 100) })
    expect(presigned.status).toBe(201)
    expect(put!.status).toBe(200)
    expect(confirmed!.status, JSON.stringify(confirmed!.body)).toBe(200)
    expect(confirmed!.body.data).toMatchObject({ status: 'active', publicUrl: expect.stringContaining('/admin-avatars/') })
    const file = await db.selectFrom('files').select('status').where('id', '=', presigned.body.data.fileId).executeTakeFirstOrThrow()
    expect(file.status).toBe('uploaded')
    const entry = await db.selectFrom('audit_logs').selectAll().where('entity_id', '=', presigned.body.data.fileId).executeTakeFirstOrThrow()
    expect(entry).toMatchObject({ action: 'file.uploaded', actor_type: 'admin', actor_id: ops.id })
  })

  it('rejects bytes that are not the declared type, and removes the file', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    const { confirmed, fileId } = await adminUpload(app, ops, { bytes: html })
    expect(confirmed!.status).toBe(415)
    const file = await db.selectFrom('files').select('status').where('id', '=', fileId!).executeTakeFirstOrThrow()
    expect(file.status).toBe('deleted')
  })

  it('cannot confirm someone else’s file or an unknown one (404)', async () => {
    const { fileId } = await adminUpload(app, ops, { bytes: pngOf(10, 10) })
    expect((await request(app).post(`${API}/uploads/${fileId}/confirm`).set(authed(stranger.token))).status).toBe(404)
    expect((await request(app).post(`${API}/uploads/${randomUUID()}/confirm`).set(authed(ops.token))).status).toBe(404)
    expect((await request(app).post(`${API}/uploads/not-a-uuid/confirm`).set(authed(ops.token))).status).toBe(404)
  })

  it('fails when nothing was uploaded to the signed url', async () => {
    const presigned = await presign(ops, { purpose: 'admin_avatar', mimeType: 'image/png', sizeBytes: 100, fileName: 'a.png' })
    const res = await request(app).post(`${API}/uploads/${presigned.body.data.fileId}/confirm`).set(authed(ops.token))
    expect(res.status).toBe(422)
  })
})
