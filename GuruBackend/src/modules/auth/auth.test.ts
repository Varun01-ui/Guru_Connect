import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { sql } from 'kysely'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { env } from '../../config/env.js'
import { db, pool } from '../../db/index.js'
import { outbox } from '../../lib/mailer.js'
import { hashPassword } from '../../lib/password.js'
import { closeRedis, getRedis } from '../../lib/redis.js'
import { sha256Hex } from '../../lib/tokens.js'
import { API, authed, createResetToken, createTestAdmin, randomIp, refresh, signIn, TEST_PASSWORD } from '../../test/helpers.js'
import { cleanupAuthData } from './auth.jobs.js'
import * as repo from './auth.repository.js'

const app = createApp()

const DEMO_EMAIL = 'sameer@gmail.com'
const DEMO_PASSWORD = 'demo@123'

const login = (email: string, password: string, ip = randomIp(), extra: Record<string, unknown> = {}) =>
  request(app).post(`${API}/auth/login`).set('X-Forwarded-For', ip).send({ email, password, ...extra })

const mailsTo = (email: string) => outbox.filter((m) => m.to === email)
const linkToken = (mail: { text: string }) => mail.text.match(/token=([\w-]+)/)?.[1] as string

beforeEach(() => {
  outbox.length = 0
})

afterAll(async () => {
  await closeRedis()
  await pool.end()
})

describe('POST /auth/login', () => {
  it('signs in the seeded demo admin with email + password', async () => {
    const res = await login(DEMO_EMAIL, DEMO_PASSWORD)

    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toEqual(expect.any(String))
    expect(res.body.data.admin).toMatchObject({ email: DEMO_EMAIL, isSuperAdmin: true })
    const cookies = res.headers['set-cookie'] as unknown as string[]
    const refreshCookie = cookies.find((c) => c.startsWith('gc_admin_rt='))!
    expect(refreshCookie).toContain('HttpOnly')
    expect(refreshCookie).toContain('SameSite=Strict')
    expect(refreshCookie).toContain('Path=/api/v1/admin/auth')
    expect(cookies.some((c) => c.startsWith('gc_admin_csrf=') && !c.includes('HttpOnly'))).toBe(true)
  })

  it('issues an access token with the documented claims', async () => {
    const admin = await createTestAdmin({ superAdmin: true })
    const res = await login(admin.email, admin.password)
    const claims = jwt.verify(res.body.data.accessToken, env.JWT_ACCESS_SECRET) as jwt.JwtPayload
    expect(claims).toMatchObject({ sub: admin.id, sa: true, iss: 'guruconnect-admin', aud: 'admin-portal' })
    expect(claims.sid).toEqual(expect.any(String))
    expect(claims.pwd).toEqual(expect.any(Number))
    expect(claims.exp! - claims.iat!).toBe(env.ACCESS_TOKEN_TTL_SECONDS)
  })

  it('rejects a wrong password (AUTH_INVALID_CREDENTIALS)', async () => {
    const admin = await createTestAdmin()
    const res = await login(admin.email, 'wrong-password')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(res.body.error.message).toBe('Email or password is incorrect.')
  })

  it('rejects an unknown email with the same generic error and audits a hashed email', async () => {
    const email = `nobody-${randomUUID()}@example.com`
    const res = await login(email, 'whatever-password')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS')
    const row = await db
      .selectFrom('audit_logs')
      .select(['new_values', 'reason'])
      .where('action', '=', 'auth.login_failed')
      .where(sql<boolean>`new_values @> ${JSON.stringify({ emailHash: sha256Hex(email) })}::jsonb`)
      .executeTakeFirst()
    expect(row?.reason).toBe('unknown_email')
    expect(JSON.stringify(row)).not.toContain(email)
  })

  it('locks the account after 5 failed attempts and emails the admin (AUTH_ACCOUNT_LOCKED)', async () => {
    const admin = await createTestAdmin()

    // The 5th failing attempt still reports "invalid credentials" (it's the one that sets the lock); only a
    // later attempt sees the account is locked (FR-1.1). Attempts come from the same IP+email, which the
    // 5/min rate limit allows exactly 5 of — the 6th request therefore uses a different IP.
    const ip = randomIp()
    for (let i = 0; i < 5; i++) {
      const res = await login(admin.email, 'wrong-password', ip)
      expect(res.status).toBe(401)
    }

    const lockedAttempt = await login(admin.email, admin.password)
    expect(lockedAttempt.status).toBe(423)
    expect(lockedAttempt.body.error.code).toBe('AUTH_ACCOUNT_LOCKED')
    expect(lockedAttempt.body.error.details.lockedUntil).toEqual(expect.any(String))
    expect(lockedAttempt.body.error.message).toMatch(/^Too many attempts\. Try again after /)

    const row = await db.selectFrom('admins').select(['status', 'failed_login_count']).where('id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ status: 'locked', failed_login_count: 5 })
    expect(mailsTo(admin.email).some((m) => m.subject.includes('tried to sign in'))).toBe(true)
  })

  it('lets a locked admin back in once the lock has expired and resets the counter', async () => {
    const admin = await createTestAdmin()
    await db
      .updateTable('admins')
      .set({ status: 'locked', failed_login_count: 5, locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', admin.id)
      .execute()

    const res = await login(admin.email, admin.password)
    expect(res.status).toBe(200)
    const row = await db.selectFrom('admins').select(['status', 'failed_login_count', 'locked_until']).where('id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ status: 'active', failed_login_count: 0, locked_until: null })
  })

  it('rejects a disabled account (AUTH_ACCOUNT_DISABLED)', async () => {
    const admin = await createTestAdmin({ status: 'disabled' })
    const res = await login(admin.email, admin.password)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED')
  })

  it('rate limits to 5 attempts a minute per IP + email (RATE_LIMITED)', async () => {
    const admin = await createTestAdmin()
    const ip = randomIp()
    for (let i = 0; i < 4; i++) {
      // 4 wrong attempts: below the lockout threshold of 5, so this isolates the request rate limit.
      expect((await login(admin.email, 'wrong-password', ip)).status).toBe(401)
    }
    expect((await login(admin.email, admin.password, ip)).status).toBe(200) // 5th attempt is still allowed

    const limited = await login(admin.email, admin.password, ip)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(limited.body.error.details.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('rate limits to 20 attempts an hour per IP across different emails', async () => {
    const ip = randomIp()
    for (let i = 0; i < 20; i++) {
      const res = await login(`nobody-${i}@example.com`, 'whatever-password', ip)
      expect(res.status).toBe(401)
    }
    const limited = await login('nobody-21@example.com', 'whatever-password', ip)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  }, 60_000)

  it('validates the request body', async () => {
    const res = await login('not-an-email', '')
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('records a login_succeeded audit row with the device', async () => {
    const admin = await createTestAdmin()
    await request(app)
      .post(`${API}/auth/login`)
      .set('X-Forwarded-For', randomIp())
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')
      .send({ email: admin.email, password: admin.password, rememberMe: true })

    const row = await db.selectFrom('audit_logs').select(['new_values']).where('action', '=', 'auth.login_succeeded').where('actor_id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row.new_values).toMatchObject({ rememberMe: true, method: 'password', device: 'Chrome on Windows' })
  })

  it('keeps sessions for 7 days, or 30 with "keep me signed in"', async () => {
    const admin = await createTestAdmin()
    const short = await signIn(app, admin.email)
    const longRes = await login(admin.email, admin.password, randomIp(), { rememberMe: true })
    const longSid = JSON.parse(Buffer.from(longRes.body.data.accessToken.split('.')[1], 'base64url').toString()).sid

    const rows = await db.selectFrom('admin_sessions').select(['id', 'expires_at', 'created_at']).where('id', 'in', [short.sessionId, longSid]).execute()
    const days = (id: string) => {
      const r = rows.find((x) => x.id === id)!
      return Math.round((new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000)
    }
    expect(days(short.sessionId)).toBe(7)
    expect(days(longSid)).toBe(30)
  })

  it('stores only the SHA-256 of the refresh token', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const row = await db.selectFrom('admin_sessions').select(['refresh_token_hash']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.refresh_token_hash).toBe(sha256Hex(session.refreshCookie))
    expect(row.refresh_token_hash).not.toBe(session.refreshCookie)
  })

  it('signs out the least recently used session when an 11th device signs in', async () => {
    const admin = await createTestAdmin()
    const sessions = []
    for (let i = 0; i < 10; i++) sessions.push(await signIn(app, admin.email))
    const eleventh = await signIn(app, admin.email)

    const list = await request(app).get(`${API}/auth/sessions`).set(authed(eleventh.accessToken))
    expect(list.body.data).toHaveLength(10)
    const oldest = await db.selectFrom('admin_sessions').select(['revoked_at']).where('id', '=', sessions[0]!.sessionId).executeTakeFirstOrThrow()
    expect(oldest.revoked_at).not.toBeNull()
  }, 60_000)
})

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and returns a new access token', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)

    const res = await refresh(app, session.refreshCookie, session.csrf)
    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toEqual(expect.any(String))
    const cookies = res.headers['set-cookie'] as unknown as string[]
    const newRefresh = cookies.find((c) => c.startsWith('gc_admin_rt='))!.split(';')[0]!.slice('gc_admin_rt='.length)
    expect(newRefresh).not.toBe(session.refreshCookie)

    const row = await db.selectFrom('admin_sessions').select(['refresh_token_hash', 'previous_token_hash']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row).toEqual({ refresh_token_hash: sha256Hex(newRefresh), previous_token_hash: sha256Hex(session.refreshCookie) })
  })

  it('rejects a missing refresh cookie (AUTH_REFRESH_INVALID)', async () => {
    const res = await request(app).post(`${API}/auth/refresh`).set('X-CSRF-Token', 'x').send({})
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REFRESH_INVALID')
  })

  it('rejects an unknown refresh token (AUTH_REFRESH_INVALID)', async () => {
    const res = await refresh(app, 'not-a-real-refresh-token', 'csrf-value')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REFRESH_INVALID')
  })

  it('rejects a missing or mismatched CSRF header (FORBIDDEN)', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)

    const missing = await request(app).post(`${API}/auth/refresh`).set('Cookie', [`gc_admin_rt=${session.refreshCookie}`, `gc_admin_csrf=${session.csrf}`]).send({})
    expect(missing.status).toBe(403)
    expect(missing.body.error.code).toBe('FORBIDDEN')

    const wrong = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', [`gc_admin_rt=${session.refreshCookie}`, `gc_admin_csrf=${session.csrf}`])
      .set('X-CSRF-Token', 'something-else')
      .send({})
    expect(wrong.status).toBe(403)
  })

  it('rejects a cross-site Origin even with a valid CSRF pair (FORBIDDEN)', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const res = await refresh(app, session.refreshCookie, session.csrf, { origin: 'https://evil.example.com' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('accepts the configured Origin', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const res = await refresh(app, session.refreshCookie, session.csrf, { origin: env.CORS_ORIGIN })
    expect(res.status).toBe(200)
  })

  it('rejects an expired session and marks it revoked (AUTH_REFRESH_INVALID)', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await db.updateTable('admin_sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', session.sessionId).execute()

    const res = await refresh(app, session.refreshCookie, session.csrf)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REFRESH_INVALID')
    const row = await db.selectFrom('admin_sessions').select(['revoked_reason']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('expired')
  })

  it('rejects a revoked session (AUTH_REFRESH_INVALID)', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await request(app).post(`${API}/auth/logout`).set(authed(session.accessToken))

    const res = await refresh(app, session.refreshCookie, session.csrf)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REFRESH_INVALID')
  })

  it('rejects refresh for a disabled admin', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', '=', admin.id).execute()

    const res = await refresh(app, session.refreshCookie, session.csrf)
    expect(res.status).toBe(401)
    const row = await db.selectFrom('admin_sessions').select(['revoked_reason']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('account_disabled')
  })

  it('serves a parallel refresh with the just-rotated token inside the grace window, without touching cookies', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const first = await refresh(app, session.refreshCookie, session.csrf)
    expect(first.status).toBe(200)

    const second = await refresh(app, session.refreshCookie, session.csrf) // second tab, old cookie
    expect(second.status).toBe(200)
    expect(second.body.data.accessToken).toEqual(expect.any(String))
    expect(second.headers['set-cookie']).toBeUndefined()

    // ...and the session is still alive afterwards.
    const alive = await request(app).get(`${API}/auth/me`).set(authed(second.body.data.accessToken))
    expect(alive.status).toBe(200)
  })

  it('detects reuse of an old refresh token after the grace window: revokes the whole family and emails the admin', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const rotated = await refresh(app, session.refreshCookie, session.csrf)
    expect(rotated.status).toBe(200)

    await db.updateTable('admin_sessions').set({ last_used_at: new Date(Date.now() - 60_000) }).where('id', '=', session.sessionId).execute()

    const replay = await refresh(app, session.refreshCookie, session.csrf)
    expect(replay.status).toBe(401)
    expect(replay.body.error.code).toBe('AUTH_REFRESH_INVALID')
    expect(replay.body.error.message).toBe('For your security we signed you out everywhere. Sign in again.')

    const row = await db.selectFrom('admin_sessions').select(['revoked_at', 'revoked_reason']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('token_reuse')
    const audited = await db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.token_reuse_detected').where('actor_id', '=', admin.id).executeTakeFirst()
    expect(audited).toBeDefined()
    expect(mailsTo(admin.email).some((m) => m.subject.includes('signed out for your security'))).toBe(true)

    // The legitimately rotated token is dead too: the whole family was revoked.
    const newRefresh = (rotated.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('gc_admin_rt='))!.split(';')[0]!.slice('gc_admin_rt='.length)
    const after = await refresh(app, newRefresh, session.csrf)
    expect(after.status).toBe(401)
  })
})

describe('authenticate middleware', () => {
  it('requires a token (AUTH_REQUIRED)', async () => {
    const res = await request(app).get(`${API}/auth/me`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('rejects a garbage token (AUTH_REQUIRED)', async () => {
    const res = await request(app).get(`${API}/auth/me`).set(authed('not.a.jwt'))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('reports an expired access token as AUTH_TOKEN_EXPIRED so the client can refresh silently', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const expired = jwt.sign({ sub: admin.id, sid: session.sessionId, sa: false, pwd: 0 }, env.JWT_ACCESS_SECRET, {
      expiresIn: -10,
      issuer: 'guruconnect-admin',
      audience: 'admin-portal',
    })
    const res = await request(app).get(`${API}/auth/me`).set(authed(expired))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED')
  })

  it('rejects a token issued before the last password change', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await db.updateTable('admins').set({ password_changed_at: new Date(Date.now() + 60_000) }).where('id', '=', admin.id).execute()

    const res = await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('rejects a valid token once the admin is disabled', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', '=', admin.id).execute()

    const res = await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))
    expect(res.status).toBe(401)
  })

  it('rejects a token whose session was revoked in the database', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await db.updateTable('admin_sessions').set({ revoked_at: new Date(), revoked_reason: 'logout' }).where('id', '=', session.sessionId).execute()

    const res = await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))
    expect(res.status).toBe(401)
  })

  it('returns the signed-in admin from /auth/me', async () => {
    const login = await signIn(app, DEMO_EMAIL, DEMO_PASSWORD)
    const res = await request(app).get(`${API}/auth/me`).set(authed(login.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.data.email).toBe(DEMO_EMAIL)
    expect(res.body.data.isSuperAdmin).toBe(true)
    expect(res.body.data.profile).toMatchObject({ timezone: expect.any(String), theme: expect.any(String) })
  })
})

describe('Redis revoked-session deny-list', () => {
  it('marks a session revoked in Redis on logout, so the next request is rejected without a DB lookup', async () => {
    const redis = await getRedis()
    expect(redis, 'Redis must be running for the test suite (REDIS_URL in .env.test)').not.toBeNull()

    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    expect((await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))).status).toBe(200)

    await request(app).post(`${API}/auth/logout`).set(authed(session.accessToken))

    expect(await redis!.exists(`revoked_sid:${session.sessionId}`)).toBe(1)
    const ttl = await redis!.ttl(`revoked_sid:${session.sessionId}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(env.ACCESS_TOKEN_TTL_SECONDS)
    expect((await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))).status).toBe(401)
  })

  it('rejects a session that is only revoked in Redis, before touching the database', async () => {
    const redis = (await getRedis())!
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    await redis.set(`revoked_sid:${session.sessionId}`, '1', 'EX', 60)

    const res = await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('backs the login rate limit with Redis counters that expire', async () => {
    const redis = (await getRedis())!
    const admin = await createTestAdmin()
    const ip = randomIp()
    await login(admin.email, admin.password, ip)

    const key = `rl:login:${ip}:${admin.email}`
    expect(await redis.get(key)).toBe('1')
    const ttl = await redis.pttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })
})

describe('logout and sessions', () => {
  it('POST /auth/logout revokes the current session and clears the cookies', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)

    const res = await request(app).post(`${API}/auth/logout`).set(authed(session.accessToken))
    expect(res.status).toBe(200)
    expect((res.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('gc_admin_rt=;'))).toBe(true)

    const row = await db.selectFrom('admin_sessions').select(['revoked_reason']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('logout')
    const audited = await db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.logout').where('actor_id', '=', admin.id).executeTakeFirst()
    expect(audited).toBeDefined()
  })

  it('POST /auth/logout requires authentication', async () => {
    const res = await request(app).post(`${API}/auth/logout`)
    expect(res.status).toBe(401)
  })

  it('POST /auth/logout-all revokes every session of the admin', async () => {
    const admin = await createTestAdmin()
    const a = await signIn(app, admin.email)
    const b = await signIn(app, admin.email)

    const res = await request(app).post(`${API}/auth/logout-all`).set(authed(a.accessToken))
    expect(res.status).toBe(200)

    expect((await request(app).get(`${API}/auth/me`).set(authed(a.accessToken))).status).toBe(401)
    expect((await request(app).get(`${API}/auth/me`).set(authed(b.accessToken))).status).toBe(401)
    const audited = await db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.logout_all').where('actor_id', '=', admin.id).executeTakeFirst()
    expect(audited).toBeDefined()
  })

  it('GET /auth/sessions lists active sessions and flags the current one', async () => {
    const admin = await createTestAdmin()
    const a = await signIn(app, admin.email)
    const b = await signIn(app, admin.email)

    const res = await request(app).get(`${API}/auth/sessions`).set(authed(b.accessToken))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data.find((s: { id: string }) => s.id === b.sessionId).isCurrent).toBe(true)
    expect(res.body.data.find((s: { id: string }) => s.id === a.sessionId).isCurrent).toBe(false)
    expect(res.body.data[0]).toEqual(expect.objectContaining({ deviceLabel: 'Chrome on Windows', ipAddress: expect.any(String), lastUsedAt: expect.any(String), createdAt: expect.any(String) }))
  })

  it('DELETE /auth/sessions/:id signs out one of your other devices', async () => {
    const admin = await createTestAdmin()
    const a = await signIn(app, admin.email)
    const b = await signIn(app, admin.email)

    const res = await request(app).delete(`${API}/auth/sessions/${a.sessionId}`).set(authed(b.accessToken))
    expect(res.status).toBe(204)

    expect((await request(app).get(`${API}/auth/me`).set(authed(a.accessToken))).status).toBe(401)
    expect((await request(app).get(`${API}/auth/me`).set(authed(b.accessToken))).status).toBe(200)
    const audited = await db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.session_revoked').where('entity_id', '=', a.sessionId).executeTakeFirst()
    expect(audited).toBeDefined()
  })

  it("refuses to revoke a session that isn't yours (NOT_FOUND)", async () => {
    const mine = await createTestAdmin()
    const theirs = await createTestAdmin()
    const mySession = await signIn(app, mine.email)
    const theirSession = await signIn(app, theirs.email)

    const res = await request(app).delete(`${API}/auth/sessions/${theirSession.sessionId}`).set(authed(mySession.accessToken))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toBe('Session not found.')
    expect((await request(app).get(`${API}/auth/me`).set(authed(theirSession.accessToken))).status).toBe(200)
  })

  it('returns NOT_FOUND for a session id that does not exist', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const res = await request(app).delete(`${API}/auth/sessions/${randomUUID()}`).set(authed(session.accessToken))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /admins/:adminId/sessions', () => {
  it('lets a super admin sign another admin out everywhere', async () => {
    const boss = await createTestAdmin({ superAdmin: true })
    const target = await createTestAdmin()
    const bossSession = await signIn(app, boss.email)
    const targetSession = await signIn(app, target.email)

    const res = await request(app).delete(`${API}/admins/${target.id}/sessions`).set(authed(bossSession.accessToken))
    expect(res.status).toBe(204)
    expect((await request(app).get(`${API}/auth/me`).set(authed(targetSession.accessToken))).status).toBe(401)
    const row = await db.selectFrom('admin_sessions').select(['revoked_reason']).where('id', '=', targetSession.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('admin_forced')
  })

  it('forbids a regular admin', async () => {
    const regular = await createTestAdmin()
    const target = await createTestAdmin()
    const session = await signIn(app, regular.email)
    const res = await request(app).delete(`${API}/admins/${target.id}/sessions`).set(authed(session.accessToken))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('returns NOT_FOUND for an unknown admin', async () => {
    const boss = await createTestAdmin({ superAdmin: true })
    const session = await signIn(app, boss.email)
    const res = await request(app).delete(`${API}/admins/${randomUUID()}/sessions`).set(authed(session.accessToken))
    expect(res.status).toBe(404)
  })
})

describe('POST /auth/forgot-password', () => {
  it('always returns 202, whether or not the account exists', async () => {
    const admin = await createTestAdmin()
    const known = await request(app).post(`${API}/auth/forgot-password`).send({ email: admin.email })
    const unknown = await request(app).post(`${API}/auth/forgot-password`).send({ email: `nobody-${randomUUID()}@example.com` })

    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(known.body).toEqual(unknown.body)
  })

  it('emails a 30-minute single-use link only when the account exists', async () => {
    const admin = await createTestAdmin()
    const nobody = `nobody-${randomUUID()}@example.com`
    await request(app).post(`${API}/auth/forgot-password`).send({ email: admin.email })
    await request(app).post(`${API}/auth/forgot-password`).send({ email: nobody })

    expect(mailsTo(nobody)).toHaveLength(0)
    const [mail] = mailsTo(admin.email)
    expect(mail!.text).toContain(`${env.ADMIN_PORTAL_URL}/reset-password?token=`)

    const row = await db.selectFrom('password_reset_tokens').selectAll().where('token_hash', '=', sha256Hex(linkToken(mail!))).executeTakeFirstOrThrow()
    expect(row.purpose).toBe('reset')
    const minutes = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 60_000
    expect(Math.round(minutes)).toBe(30)
  })

  it('invalidates the previous unused token when a new one is requested', async () => {
    const admin = await createTestAdmin()
    await request(app).post(`${API}/auth/forgot-password`).send({ email: admin.email })
    await request(app).post(`${API}/auth/forgot-password`).send({ email: admin.email })
    const [first, second] = mailsTo(admin.email)

    expect((await request(app).get(`${API}/auth/reset-password/validate`).query({ token: linkToken(first!) })).status).toBe(410)
    expect((await request(app).get(`${API}/auth/reset-password/validate`).query({ token: linkToken(second!) })).status).toBe(200)
  })

  it('does not email disabled accounts', async () => {
    const admin = await createTestAdmin({ status: 'disabled' })
    const res = await request(app).post(`${API}/auth/forgot-password`).send({ email: admin.email })
    expect(res.status).toBe(202)
    expect(mailsTo(admin.email)).toHaveLength(0)
  })

  it('limits to 3 requests an hour per email (RATE_LIMITED), even for unknown accounts', async () => {
    const email = `nobody-${randomUUID()}@example.com`
    for (let i = 0; i < 3; i++) expect((await request(app).post(`${API}/auth/forgot-password`).send({ email })).status).toBe(202)

    const limited = await request(app).post(`${API}/auth/forgot-password`).send({ email })
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  })

  it('validates the email', async () => {
    const res = await request(app).post(`${API}/auth/forgot-password`).send({ email: 'nope' })
    expect(res.status).toBe(422)
  })
})

describe('reset password', () => {
  it('sets a new password, revokes sessions, emails a confirmation and burns the token', async () => {
    const admin = await createTestAdmin()
    const session = await signIn(app, admin.email)
    const token = await createResetToken(admin.id)

    const valid = await request(app).get(`${API}/auth/reset-password/validate`).query({ token })
    expect(valid.status).toBe(200)
    expect(valid.body.data.purpose).toBe('reset')

    const reset = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Brand!NewPassw0rd' })
    expect(reset.status).toBe(200)

    expect((await request(app).get(`${API}/auth/me`).set(authed(session.accessToken))).status).toBe(401)
    expect((await login(admin.email, admin.password)).status).toBe(401)
    expect((await login(admin.email, 'Brand!NewPassw0rd')).status).toBe(200)
    expect(mailsTo(admin.email).some((m) => m.subject.includes('password was changed'))).toBe(true)

    const row = await db.selectFrom('admin_sessions').select(['revoked_reason']).where('id', '=', session.sessionId).executeTakeFirstOrThrow()
    expect(row.revoked_reason).toBe('password_changed')
    const audit = await db.selectFrom('audit_logs').select(['new_values']).where('action', '=', 'auth.password_reset').where('actor_id', '=', admin.id).executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ sessionsRevoked: 1 })

    const reused = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Another!Passw0rd1' })
    expect(reused.status).toBe(410)
    expect(reused.body.error.code).toBe('AUTH_LINK_EXPIRED')
  })

  it('clears a lockout', async () => {
    const admin = await createTestAdmin()
    await db.updateTable('admins').set({ status: 'locked', failed_login_count: 5, locked_until: new Date(Date.now() + 600_000) }).where('id', '=', admin.id).execute()
    const token = await createResetToken(admin.id)

    await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Brand!NewPassw0rd' })
    const row = await db.selectFrom('admins').select(['status', 'failed_login_count', 'locked_until']).where('id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ status: 'active', failed_login_count: 0, locked_until: null })
  })

  it('rejects an unknown token (AUTH_LINK_EXPIRED)', async () => {
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token: 'this-token-does-not-exist-anywhere', newPassword: 'Brand!NewPassw0rd' })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('AUTH_LINK_EXPIRED')
    expect(res.body.error.message).toBe('This link has expired. Request a new one.')
  })

  it('rejects an expired token (AUTH_LINK_EXPIRED)', async () => {
    const admin = await createTestAdmin()
    const token = await createResetToken(admin.id, { expiresInMs: -1000 })
    expect((await request(app).get(`${API}/auth/reset-password/validate`).query({ token })).status).toBe(410)
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Brand!NewPassw0rd' })).status).toBe(410)
  })

  it('rejects an already-used token (AUTH_LINK_EXPIRED)', async () => {
    const admin = await createTestAdmin()
    const token = await createResetToken(admin.id, { usedAt: new Date() })
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Brand!NewPassw0rd' })
    expect(res.status).toBe(410)
  })

  it('does not re-enable a disabled admin', async () => {
    const admin = await createTestAdmin({ status: 'disabled' })
    const token = await createResetToken(admin.id)
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Brand!NewPassw0rd' })
    expect(res.status).toBe(410)
    const row = await db.selectFrom('admins').select('status').where('id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row.status).toBe('disabled')
  })

  it('enforces the password policy with field-level messages (VALIDATION_FAILED)', async () => {
    const admin = await createTestAdmin()
    const token = await createResetToken(admin.id)

    const tooShort = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Short1!' })
    expect(tooShort.status).toBe(422)
    expect(tooShort.body.error.code).toBe('VALIDATION_FAILED')
    expect(tooShort.body.error.details).toEqual(expect.arrayContaining([{ path: 'newPassword', message: 'Use at least 12 characters.' }]))

    const oneClass = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'alllowercaseletters' })
    expect(oneClass.body.error.details).toEqual(expect.arrayContaining([{ path: 'newPassword', message: 'Use at least 3 of: lowercase, uppercase, digit, symbol.' }]))

    const tooLong = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: `Aa1!${'x'.repeat(130)}` })
    expect(tooLong.status).toBe(422)

    const common = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Password123456' })
    expect(common.body.error.details).toEqual(expect.arrayContaining([{ path: 'newPassword', message: 'That password is too common.' }]))

    // None of the rejected attempts burned the token.
    expect((await request(app).get(`${API}/auth/reset-password/validate`).query({ token })).status).toBe(200)
  })

  it("rejects a password equal to the admin's email or name (VALIDATION_FAILED)", async () => {
    const admin = await createTestAdmin({ fullName: 'Aarav Mehta Kumar' })
    const token = await createResetToken(admin.id)

    const sameAsEmail = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: admin.email })
    expect(sameAsEmail.status).toBe(422)
    expect(sameAsEmail.body.error.details).toEqual(expect.arrayContaining([{ path: 'newPassword', message: "Password can't be your email." }]))

    const sameAsName = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Aarav Mehta Kumar' })
    expect(sameAsName.status).toBe(422)
    expect(sameAsName.body.error.details).toEqual(expect.arrayContaining([{ path: 'newPassword', message: "Password can't be your name." }]))
  })

  it('rejects a new password equal to the current one (VALIDATION_FAILED)', async () => {
    const admin = await createTestAdmin()
    const token = await createResetToken(admin.id)
    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: TEST_PASSWORD })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toEqual([{ path: 'newPassword', message: "Choose a password you haven't used before." }])
  })

  it('validates the token format on the validate endpoint', async () => {
    const res = await request(app).get(`${API}/auth/reset-password/validate`)
    expect(res.status).toBe(422)
  })
})

describe('invite flow (accept-invite)', () => {
  it('activates an invited admin when they set their password', async () => {
    const admin = await createTestAdmin({ status: 'invited' })
    const token = await createResetToken(admin.id, { purpose: 'invite', expiresInMs: 72 * 3_600_000 })

    const check = await request(app).get(`${API}/auth/reset-password/validate`).query({ token })
    expect(check.body.data.purpose).toBe('invite')

    const res = await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Welcome!Aboard42' })
    expect(res.status).toBe(200)
    const row = await db.selectFrom('admins').select('status').where('id', '=', admin.id).executeTakeFirstOrThrow()
    expect(row.status).toBe('active')
    expect((await login(admin.email, 'Welcome!Aboard42')).status).toBe(200)
    const audited = await db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.invite_accepted').where('actor_id', '=', admin.id).executeTakeFirst()
    expect(audited).toBeDefined()
  })

  it('creates a bootstrap admin (admin:create) that cannot sign in until the invite is accepted', async () => {
    const email = `bootstrap-${randomUUID()}@example.com`
    const created = await repo.createInvitedAdmin({
      email,
      fullName: 'Bootstrap Admin',
      passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      isSuperAdmin: true,
    })
    const row = await db.selectFrom('admins').select(['status', 'is_super_admin']).where('id', '=', created.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'invited', is_super_admin: true })

    expect((await login(email, 'Welcome!Aboard42')).status).toBe(401)

    const token = await createResetToken(created.id, { purpose: 'invite', expiresInMs: 72 * 3_600_000 })
    await request(app).post(`${API}/auth/reset-password`).send({ token, newPassword: 'Welcome!Aboard42' })
    const ok = await login(email, 'Welcome!Aboard42')
    expect(ok.status).toBe(200)
    expect(ok.body.data.admin.isSuperAdmin).toBe(true)
  })
})

describe('mobile OTP login', () => {
  it('requests and verifies a code, then signs in', async () => {
    const phone = '9812345670'
    await createTestAdmin({ phone: '+919812345670' })

    const requested = await request(app).post(`${API}/auth/otp/request`).send({ phone })
    expect(requested.status).toBe(200)
    expect(requested.body.data.devCode).toMatch(/^\d{6}$/)

    const logs = await request(app).get(`${API}/auth/otp/logs`).query({ phone })
    expect(logs.status).toBe(200)
    expect(logs.body.data[0]).toMatchObject({ code: requested.body.data.devCode, status: 'pending' })

    const verified = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: requested.body.data.devCode })
    expect(verified.status).toBe(200)
    expect(verified.body.data.accessToken).toEqual(expect.any(String))
  })

  it('rejects a wrong code', async () => {
    const phone = '9812345671'
    await createTestAdmin({ phone: '+919812345671' })
    await request(app).post(`${API}/auth/otp/request`).send({ phone })

    const res = await request(app).post(`${API}/auth/otp/verify`).send({ phone, code: '000000' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('OTP_INVALID')
  })

  it('works for a number that is not registered to any admin (falls back to the super admin)', async () => {
    const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: '9000000000' })
    expect(res.status).toBe(200)
    expect(res.body.data.devCode).toMatch(/^\d{6}$/)
  })

  it('rate limits code requests per number', async () => {
    const phone = `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
    for (let i = 0; i < 5; i++) expect((await request(app).post(`${API}/auth/otp/request`).send({ phone })).status).toBe(200)
    const limited = await request(app).post(`${API}/auth/otp/request`).send({ phone })
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  })
})

describe('nightly cleanup job', () => {
  it('deletes sessions and reset tokens past their retention window and keeps the rest', async () => {
    const admin = await createTestAdmin()
    const day = 86_400_000
    const oldSession = await signIn(app, admin.email)
    const recentRevoked = await signIn(app, admin.email)
    const live = await signIn(app, admin.email)
    await db.updateTable('admin_sessions').set({ revoked_at: new Date(Date.now() - 40 * day), revoked_reason: 'logout' }).where('id', '=', oldSession.sessionId).execute()
    await db.updateTable('admin_sessions').set({ revoked_at: new Date(Date.now() - 2 * day), revoked_reason: 'logout' }).where('id', '=', recentRevoked.sessionId).execute()

    const oldToken = await createResetToken(admin.id, { usedAt: new Date(Date.now() - 10 * day) })
    const freshUsedToken = await createResetToken(admin.id, { usedAt: new Date(Date.now() - 1 * day) })
    const liveToken = await createResetToken(admin.id)

    const result = await cleanupAuthData()
    expect(result.sessions).toBeGreaterThanOrEqual(1)
    expect(result.resetTokens).toBeGreaterThanOrEqual(1)

    const sessionIds = (await db.selectFrom('admin_sessions').select('id').where('admin_id', '=', admin.id).execute()).map((r) => r.id)
    expect(sessionIds).not.toContain(oldSession.sessionId)
    expect(sessionIds).toEqual(expect.arrayContaining([recentRevoked.sessionId, live.sessionId]))

    const tokenHashes = (await db.selectFrom('password_reset_tokens').select('token_hash').where('admin_id', '=', admin.id).execute()).map((r) => r.token_hash)
    expect(tokenHashes).not.toContain(sha256Hex(oldToken))
    expect(tokenHashes).toEqual(expect.arrayContaining([sha256Hex(freshUsedToken), sha256Hex(liveToken)]))
  })
})
