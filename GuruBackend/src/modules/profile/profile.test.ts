import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db } from '../../db/index.js'
import { outbox } from '../../lib/mailer.js'
import { sha256Hex } from '../../lib/tokens.js'
import { pngOf } from '../../test/images.js'
import { API, TEST_PASSWORD, adminUpload, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const EMAIL_PREFIX = 'prof-test'
const NEW_PASSWORD = 'Quiet-River-Lamp-77'
const RUN = Math.floor(Math.random() * 1e7)
let phoneSeq = 0
const nextPhone = () => `+9177${String(RUN).padStart(7, '0')}${phoneSeq++}`.slice(0, 13)

let me: TestAdmin
let other: TestAdmin

const get = (a: { token: string }) => request(app).get(`${API}/me/profile`).set(authed(a.token))
const patch = (a: { token: string }, body: object, version: string) => request(app).patch(`${API}/me/profile`).set(authed(a.token)).set('If-Match', version).send(body)
// Reads the current version, then saves: the common case of a form opened a moment ago.
const save = async (a: { token: string }, body: object) => patch(a, body, (await get(a)).body.data.updatedAt)
const putAvatar = (a: { token: string }, fileId: unknown) => request(app).put(`${API}/me/profile/avatar`).set(authed(a.token)).send({ fileId })
const auditActions = async (adminId: string) =>
  (await db.selectFrom('audit_logs').select('action').where('actor_id', '=', adminId).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)

beforeAll(async () => {
  me = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX, fullName: 'Anjali Menon' })
  other = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
})

afterAll(async () => {
  await purgeRbacFixtures(EMAIL_PREFIX)
})

describe('authentication', () => {
  it('needs a signed-in admin on every endpoint', async () => {
    expect((await request(app).get(`${API}/me/profile`)).status).toBe(401)
    expect((await request(app).patch(`${API}/me/profile`).send({})).status).toBe(401)
    expect((await request(app).put(`${API}/me/profile/avatar`).send({})).status).toBe(401)
    expect((await request(app).delete(`${API}/me/profile/avatar`)).status).toBe(401)
    expect((await request(app).post(`${API}/me/change-password`).send({})).status).toBe(401)
  })
})

describe('GET /me/profile', () => {
  it('creates the profile row lazily with defaults and shows roles', async () => {
    expect(await db.selectFrom('admin_profiles').select('admin_id').where('admin_id', '=', me.id).executeTakeFirst()).toBeUndefined()
    const res = await get(me)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      id: me.id,
      email: me.email,
      fullName: 'Anjali Menon',
      displayName: null,
      designation: null,
      phone: null,
      avatar: null,
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      theme: 'system',
      notificationPrefs: { email_digest: true, queue_alerts: true, security_alerts: true },
      roles: ['Finance Admin'],
    })
    expect(res.body.data.updatedAt).toBeTruthy()
    expect(await db.selectFrom('admin_profiles').select('admin_id').where('admin_id', '=', me.id).executeTakeFirst()).toBeTruthy()
  })

  it('only ever shows the caller’s own profile', async () => {
    const res = await get(other)
    expect(res.body.data.id).toBe(other.id)
    expect(res.body.data.roles).toEqual(['Operations Admin'])
  })
})

describe('PATCH /me/profile', () => {
  it('updates the profile, including the name on the admin account, and audits changed fields with the phone masked', async () => {
    const phone = nextPhone()
    const res = await save(me, {
      fullName: '  Anjali   Menon-Nair ',
      displayName: 'Anjali',
      designation: 'Verification Lead',
      phone,
      timezone: 'Asia/Dubai',
      locale: 'hi-IN',
      theme: 'dark',
      notificationPrefs: { queue_alerts: false },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({
      fullName: 'Anjali Menon-Nair',
      displayName: 'Anjali',
      designation: 'Verification Lead',
      phone,
      timezone: 'Asia/Dubai',
      locale: 'hi-IN',
      theme: 'dark',
      notificationPrefs: { email_digest: true, queue_alerts: false, security_alerts: true },
    })
    const admin = await db.selectFrom('admins').select('full_name').where('id', '=', me.id).executeTakeFirstOrThrow()
    expect(admin.full_name).toBe('Anjali Menon-Nair')

    const entry = await db.selectFrom('audit_logs').selectAll().where('actor_id', '=', me.id).where('action', '=', 'admin_profile.updated').orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    expect(entry.new_values).toMatchObject({ designation: 'Verification Lead', theme: 'dark' })
    expect(JSON.stringify(entry.new_values)).not.toContain(phone)
    expect((entry.new_values as { phone: string }).phone).toContain('XXXXX')
  })

  it('moves updatedAt forward on every real change, even when only the name changes', async () => {
    const before = (await get(me)).body.data.updatedAt
    await new Promise((r) => setTimeout(r, 15))
    const res = await save(me, { fullName: 'Anjali Menon' })
    expect(res.status).toBe(200)
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('clears optional fields with null', async () => {
    await save(me, { displayName: 'Anj', designation: 'Lead' })
    const res = await save(me, { displayName: null, designation: null, phone: null })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ displayName: null, designation: null, phone: null })
  })

  it('treats an unchanged save as a no-op: no new audit row', async () => {
    await save(me, { theme: 'light' })
    const before = (await auditActions(me.id)).length
    const res = await save(me, { theme: 'light', timezone: 'Asia/Dubai' })
    expect(res.status).toBe(200)
    expect((await auditActions(me.id)).length).toBe(before)
  })

  it('merges notification preferences instead of replacing them', async () => {
    await save(me, { notificationPrefs: { email_digest: false, queue_alerts: true } })
    const res = await save(me, { notificationPrefs: { queue_alerts: false } })
    expect(res.body.data.notificationPrefs).toEqual({ email_digest: false, queue_alerts: false, security_alerts: true })
  })

  it.each([
    ['fullName too short', { fullName: 'A' }, 'fullName', 'Name must be 2–100 characters.'],
    ['fullName too long', { fullName: 'A'.repeat(101) }, 'fullName', 'Name must be 2–100 characters.'],
    ['displayName too short', { displayName: 'A' }, 'displayName', 'Display name must be 2–40 characters.'],
    ['displayName too long', { displayName: 'A'.repeat(41) }, 'displayName', 'Display name must be 2–40 characters.'],
    ['designation too long', { designation: 'D'.repeat(81) }, 'designation', 'Designation can be up to 80 characters.'],
    ['phone not E.164', { phone: '98450 11122' }, 'phone', 'Enter a phone number like +919876543210.'],
    ['time zone not real', { timezone: 'Mars/Olympus' }, 'timezone', 'Pick a time zone from the list.'],
    ['locale not offered', { locale: 'fr-FR' }, 'locale', 'Choose English or Hindi.'],
    ['theme not offered', { theme: 'neon' }, 'theme', 'Choose light, dark or system.'],
  ])('rejects %s (422)', async (_label, body, path, message) => {
    const res = await save(me, body)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details[0]).toEqual({ path, message })
  })

  it('rejects fields an admin must not edit themselves (email, roles, security alerts, unknown keys)', async () => {
    for (const body of [{ email: 'new@example.com' }, { roles: ['super_admin'] }, { isSuperAdmin: true }, { notificationPrefs: { security_alerts: false } }, { nonsense: 1 }, {}]) {
      const res = await save(me, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
    }
    expect((await get(me)).body.data.email).toBe(me.email)
  })

  it('refuses a stale profile (409) and returns the current one', async () => {
    const stale = (await get(me)).body.data.updatedAt
    await new Promise((r) => setTimeout(r, 15))
    expect((await save(me, { designation: 'Version A' })).status).toBe(200)
    const res = await patch(me, { designation: 'Version B' }, stale)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Your profile changed in another tab. Reload.' })
    expect(res.body.error.details.current.designation).toBe('Version A')
    expect((await get(me)).body.data.designation).toBe('Version A')
  })

  it('needs an If-Match header', async () => {
    const res = await request(app).patch(`${API}/me/profile`).set(authed(me.token)).send({ theme: 'dark' })
    expect(res.status).toBe(422)
  })

  it('refuses a phone number another admin already uses (409)', async () => {
    const phone = nextPhone()
    expect((await save(other, { phone })).status).toBe(200)
    const res = await save(me, { phone })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
  })

  it('changes only the caller’s own profile', async () => {
    const before = (await get(other)).body.data
    await save(me, { designation: 'Only mine' })
    expect((await get(other)).body.data.designation).toBe(before.designation)
  })
})

describe('avatar', () => {
  const upload = (a: TestAdmin, over: Parameters<typeof adminUpload>[2] = { bytes: pngOf(256, 256) }) => adminUpload(app, a, over)

  it('sets an uploaded image as the avatar and serves its CDN url', async () => {
    const { confirmed, fileId } = await upload(me)
    expect(confirmed!.status, JSON.stringify(confirmed!.body)).toBe(200)
    const res = await putAvatar(me, fileId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.avatar.fileId).toBe(fileId)
    expect(res.body.data.avatar.url).toMatch(/admin-avatars\/.+\.png$/)
    expect((await get(me)).body.data.avatar.fileId).toBe(fileId)
    expect(await auditActions(me.id)).toContain('admin_profile.avatar_changed')

    const meRes = await request(app).get(`${API}/auth/me`).set(authed(me.token))
    expect(meRes.body.data.profile.avatarUrl).toBe(res.body.data.avatar.url)
  })

  it('replaces the avatar and soft-deletes the old file', async () => {
    const first = await upload(me)
    await putAvatar(me, first.fileId)
    const second = await upload(me)
    const res = await putAvatar(me, second.fileId)
    expect(res.status).toBe(200)
    expect(res.body.data.avatar.fileId).toBe(second.fileId)
    const old = await db.selectFrom('files').select(['status', 'deleted_at']).where('id', '=', first.fileId!).executeTakeFirstOrThrow()
    expect(old.status).toBe('deleted')
    expect(old.deleted_at).not.toBeNull()
  })

  it('is idempotent for the same file', async () => {
    const { fileId } = await upload(me)
    await putAvatar(me, fileId)
    const again = await putAvatar(me, fileId)
    expect(again.status).toBe(200)
    const file = await db.selectFrom('files').select('status').where('id', '=', fileId!).executeTakeFirstOrThrow()
    expect(file.status).toBe('uploaded')
  })

  it('rejects a file that is not a finished admin_avatar image of the caller (422)', async () => {
    const notMine = await upload(other)
    const pending = await adminUpload(app, me, { bytes: pngOf(10, 10) }) // confirmed — then reset to pending below
    await db.updateTable('files').set({ status: 'pending' }).where('id', '=', pending.fileId!).execute()
    const bannerImage = await adminUpload(app, me, { purpose: 'admin_avatar', bytes: pngOf(10, 10) })
    await db.updateTable('files').set({ purpose: 'banner_image' }).where('id', '=', bannerImage.fileId!).execute()
    const nonImage = await adminUpload(app, me, { bytes: pngOf(10, 10) })
    await db.updateTable('files').set({ mime_type: 'application/pdf' }).where('id', '=', nonImage.fileId!).execute()

    for (const id of [notMine.fileId, pending.fileId, bannerImage.fileId, nonImage.fileId, randomUUID(), 'not-a-uuid']) {
      const res = await putAvatar(me, id)
      expect(res.status, String(id)).toBe(422)
      expect(res.body.error.message).toBe('Upload a JPG, PNG or WebP image.')
    }
  })

  it('removes the avatar and its file', async () => {
    const { fileId } = await upload(me)
    await putAvatar(me, fileId)
    const res = await request(app).delete(`${API}/me/profile/avatar`).set(authed(me.token))
    expect(res.status).toBe(200)
    expect(res.body.data.avatar).toBeNull()
    const file = await db.selectFrom('files').select('status').where('id', '=', fileId!).executeTakeFirstOrThrow()
    expect(file.status).toBe('deleted')
    expect(await auditActions(me.id)).toContain('admin_profile.avatar_removed')
    // Removing again is harmless.
    expect((await request(app).delete(`${API}/me/profile/avatar`).set(authed(me.token))).status).toBe(200)
  })
})

describe('POST /me/change-password', () => {
  async function freshAdmin() {
    const admin = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX, fullName: 'Pass Word' })
    return admin
  }
  const change = (a: { token: string }, body: object) => request(app).post(`${API}/me/change-password`).set(authed(a.token)).send(body)
  const addSession = async (adminId: string) =>
    (
      await db
        .insertInto('admin_sessions')
        .values({ admin_id: adminId, refresh_token_hash: sha256Hex(randomUUID()), expires_at: new Date(Date.now() + 86_400_000) })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  const revokedAt = async (sessionId: string) => (await db.selectFrom('admin_sessions').select('revoked_at').where('id', '=', sessionId).executeTakeFirstOrThrow()).revoked_at

  it('changes the password, keeps this session alive with a fresh token and signs out the others', async () => {
    const admin = await freshAdmin()
    const otherSession = await addSession(admin.id)
    const res = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ accessToken: expect.any(String), expiresIn: expect.any(Number), sessionsRevoked: 1 })

    expect(await revokedAt(otherSession)).not.toBeNull()
    expect(await revokedAt(admin.sessionId)).toBeNull()
    // The old token carries the old password version; the new one works.
    expect((await get(admin)).status).toBe(401)
    expect((await get({ token: res.body.data.accessToken })).status).toBe(200)
    expect(await auditActions(admin.id)).toContain('auth.password_changed')
    expect(outbox.some((m) => m.to === admin.email && /password was changed/i.test(m.subject))).toBe(true)

    // And the new password really signs in.
    const login = await request(app).post(`${API}/auth/login`).set('X-Forwarded-For', `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`).send({ email: admin.email, password: NEW_PASSWORD })
    expect(login.status).toBe(200)
  })

  it('keeps other sessions when asked to', async () => {
    const admin = await freshAdmin()
    const otherSession = await addSession(admin.id)
    const res = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: false })
    expect(res.status).toBe(200)
    expect(res.body.data.sessionsRevoked).toBe(0)
    expect(await revokedAt(otherSession)).toBeNull()
  })

  it('signs out other sessions by default', async () => {
    const admin = await freshAdmin()
    const otherSession = await addSession(admin.id)
    const res = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(200)
    expect(await revokedAt(otherSession)).not.toBeNull()
  })

  it('rejects a wrong current password (401), audits it and leaves the password alone', async () => {
    const admin = await freshAdmin()
    const res = await change(admin, { currentPassword: 'Wrong-Password-1', newPassword: NEW_PASSWORD })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Your current password is incorrect.' })
    expect(await auditActions(admin.id)).toContain('auth.password_change_failed')
    expect((await get(admin)).status).toBe(200) // token still valid: nothing changed
  })

  it('locks the account after repeated wrong current passwords (423)', async () => {
    const admin = await freshAdmin()
    for (let i = 0; i < 5; i++) expect((await change(admin, { currentPassword: 'Wrong-Password-1', newPassword: NEW_PASSWORD })).status).toBe(401)
    const locked = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
    expect(locked.status).toBe(423)
    expect(locked.body.error.code).toBe('AUTH_ACCOUNT_LOCKED')
    expect(locked.body.error.message).toMatch(/^Too many attempts\. Try again after /)
    expect(outbox.some((m) => m.to === admin.email && /locked|sign in/i.test(m.subject + m.text))).toBe(true)
  })

  it('applies the password policy (422) with the whole checklist', async () => {
    const admin = await freshAdmin()
    const res = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: 'short' })
    expect(res.status).toBe(422)
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain('newPassword')
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(2)
    expect((await change(admin, { currentPassword: TEST_PASSWORD, newPassword: 'alllowercaseletters' })).status).toBe(422)
    expect((await change(admin, { currentPassword: TEST_PASSWORD, newPassword: 'Pass Word' })).status).toBe(422)
  })

  it('refuses to reuse the current password (422)', async () => {
    const admin = await freshAdmin()
    const res = await change(admin, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toBe("Choose a password you haven't used before.")
  })

  it('rejects malformed bodies', async () => {
    const admin = await freshAdmin()
    expect((await change(admin, {})).status).toBe(422)
    expect((await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, signOutOtherSessions: 'yes' })).status).toBe(422)
    expect((await change(admin, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, email: 'x@y.z' })).status).toBe(422)
  })
})
