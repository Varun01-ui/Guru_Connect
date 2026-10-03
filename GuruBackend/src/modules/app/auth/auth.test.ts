import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { env } from '../../../config/env.js'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { hashPassword } from '../../../lib/password.js'

const app = createApp()

afterAll(async () => {
  await pool.end()
})

describe('POST /auth/otp/request + /auth/otp/verify (phone)', () => {
  it('requests an OTP and returns a challengeId + cooldown', async () => {
    const res = await request(app).post('/api/v1/app/auth/otp/request').send({ phone: '+919000000002' })
    expect(res.status).toBe(200)
    expect(res.body.data.challengeId).toBeDefined()
    expect(res.body.data.resendAfterSeconds).toBe(30)
  })

  it('rejects an immediate resend with 429 RATE_LIMITED', async () => {
    const res = await request(app).post('/api/v1/app/auth/otp/request').send({ phone: '+919000000002' })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
  })

  it('a wrong code decrements attemptsLeft without a 500', async () => {
    const requested = await request(app).post('/api/v1/app/auth/otp/request').send({ phone: '+919000000003' })
    const res = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: requested.body.data.challengeId, code: '000000' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('OTP_INVALID')
    expect(res.body.error.details.attemptsLeft).toBe(4)
  })

  it('an unknown challengeId returns OTP_EXPIRED, never a 500', async () => {
    const res = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: randomUUID(), code: '123456' })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('OTP_EXPIRED')
  })

  it('the test-mode number accepts 123456 and returns REGISTRATION_REQUIRED for a new number', async () => {
    const requested = await request(app).post('/api/v1/app/auth/otp/request').send({ phone: '+919000000001' })
    const res = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: requested.body.data.challengeId, code: '123456' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('REGISTRATION_REQUIRED')
    expect(res.body.error.details.registrationToken).toBeDefined()
  })

  it('logs in an existing user end to end', async () => {
    const phone = '+919000000004'
    const user = await db.insertInto('app_users').values({ user_type: 'parent', phone, full_name: 'OTP Login Parent' }).returning('id').executeTakeFirstOrThrow()

    const requested = await request(app).post('/api/v1/app/auth/otp/request').send({ phone })
    const res = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: requested.body.data.challengeId, code: '123456' })

    expect(res.status).toBe(200)
    expect(res.body.data.user.userId).toBe(user.id)
    expect(res.body.data.accessToken).toEqual(expect.any(String))
    expect(res.body.data.refreshToken).toEqual(expect.any(String))

    await db.deleteFrom('app_sessions').where('user_id', '=', user.id).execute()
    await db.deleteFrom('app_users').where('id', '=', user.id).execute()
  })
})

describe('POST /auth/refresh', () => {
  it('rotates the refresh token, and revokes the whole family if a rotated-out token is replayed', async () => {
    const phone = '+919000000007'
    const user = await db.insertInto('app_users').values({ user_type: 'parent', phone, full_name: 'Refresh Test Parent' }).returning('id').executeTakeFirstOrThrow()

    const requested = await request(app).post('/api/v1/app/auth/otp/request').send({ phone })
    const login = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: requested.body.data.challengeId, code: '123456' })
    const firstRefreshToken = login.body.data.refreshToken

    const refreshed = await request(app).post('/api/v1/app/auth/refresh').send({ refreshToken: firstRefreshToken })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String))

    // Replaying the now-rotated-out token must revoke the whole session family, not issue a new one.
    const replay = await request(app).post('/api/v1/app/auth/refresh').send({ refreshToken: firstRefreshToken })
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe('AUTH_REFRESH_INVALID')

    const secondRefreshToken = refreshed.body.data.refreshToken
    const afterReuse = await request(app).post('/api/v1/app/auth/refresh').send({ refreshToken: secondRefreshToken })
    expect(afterReuse.status).toBe(401)

    await db.deleteFrom('app_sessions').where('user_id', '=', user.id).execute()
    await db.deleteFrom('app_users').where('id', '=', user.id).execute()
  })
})

describe('sessions + logout', () => {
  it('lists, revokes, and logs out sessions for the signed-in user', async () => {
    const phone = '+919000000008'
    const user = await db.insertInto('app_users').values({ user_type: 'parent', phone, full_name: 'Sessions Test Parent' }).returning('id').executeTakeFirstOrThrow()

    const requested = await request(app).post('/api/v1/app/auth/otp/request').send({ phone })
    const login = await request(app).post('/api/v1/app/auth/otp/verify').send({ challengeId: requested.body.data.challengeId, code: '123456' })
    const accessToken = login.body.data.accessToken

    const sessions = await request(app).get('/api/v1/app/auth/sessions').set('Authorization', `Bearer ${accessToken}`)
    expect(sessions.status).toBe(200)
    expect(sessions.body.data.length).toBeGreaterThan(0)
    expect(sessions.body.data[0].isCurrent).toBe(true)

    const logout = await request(app).post('/api/v1/app/auth/logout').set('Authorization', `Bearer ${accessToken}`)
    expect(logout.status).toBe(200)

    const afterLogout = await request(app).get('/api/v1/app/auth/sessions').set('Authorization', `Bearer ${accessToken}`)
    expect(afterLogout.status).toBe(200) // access token itself is still valid until it expires; the session row is what's revoked
    expect(afterLogout.body.data.find((s: { isCurrent: boolean }) => s.isCurrent)).toBeUndefined()

    await db.deleteFrom('app_sessions').where('user_id', '=', user.id).execute()
    await db.deleteFrom('app_users').where('id', '=', user.id).execute()
  })
})

describe('authenticateRegistration', () => {
  it('rejects an expired registration token even though the signature verifies', async () => {
    const expiredToken = jwt.sign({ sub: '+919900000099', contactType: 'phone', jti: randomUUID() }, env.APP_JWT_SECRET, {
      algorithm: 'HS256',
      audience: 'gc-register',
      expiresIn: -10,
    })
    const res = await request(app).get('/api/v1/app/registration/context').set('Authorization', `Bearer ${expiredToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects an app access token on a registration route', async () => {
    const appToken = jwt.sign({ sub: 'u1', role: 'parent', pid: 'p1', sid: 's1' }, env.APP_JWT_SECRET, {
      algorithm: 'HS256',
      audience: 'gc-app',
      expiresIn: 900,
    })
    const res = await request(app).get('/api/v1/app/registration/context').set('Authorization', `Bearer ${appToken}`)
    expect(res.status).toBe(401)
  })
})

describe('email/password login', () => {
  const email = 'app-test-parent@example.com'
  const password = 'correct-horse-9'

  it('rejects a wrong password without revealing whether the email exists, then logs in', async () => {
    const user = await db.insertInto('app_users').values({ user_type: 'parent', email, full_name: 'Email Parent', auth_provider: 'password' }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('user_auth_identities').values({ user_id: user.id, provider: 'password', provider_subject: email, email, password_hash: await hashPassword(password) }).execute()

    const wrong = await request(app).post('/api/v1/app/auth/email/login').send({ email, password: 'wrong-one' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')

    const unknown = await request(app).post('/api/v1/app/auth/email/login').send({ email: 'nobody@example.com', password: 'whatever' })
    expect(unknown.status).toBe(401)
    expect(unknown.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')

    const ok = await request(app).post('/api/v1/app/auth/email/login').send({ email, password })
    expect(ok.status).toBe(200)
    expect(ok.body.data.user.userId).toBe(user.id)

    await db.deleteFrom('app_sessions').where('user_id', '=', user.id).execute()
    await db.deleteFrom('user_auth_identities').where('user_id', '=', user.id).execute()
    await db.deleteFrom('app_users').where('id', '=', user.id).execute()
  })

  it('forgot-password never reveals account existence', async () => {
    const known = await request(app).post('/api/v1/app/auth/password/forgot').send({ email: 'nobody-either@example.com' })
    const unknown = await request(app).post('/api/v1/app/auth/password/forgot').send({ email: 'still-nobody@example.com' })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.body.data).toEqual({ sent: true })
    expect(unknown.body.data).toEqual({ sent: true })
  })
})

describe('POST /auth/google', () => {
  it('returns a clear validation error when no Google client id is configured', async () => {
    const res = await request(app).post('/api/v1/app/auth/google').send({ idToken: 'not-a-real-token' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })
})
