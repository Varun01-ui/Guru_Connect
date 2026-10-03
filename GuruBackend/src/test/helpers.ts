import { randomUUID } from 'node:crypto'
import type { Test } from 'supertest'
import request from 'supertest'
import type { Express } from 'express'
import { db } from '../db/index.js'
import { hashPassword } from '../lib/password.js'
import { generateOpaqueToken, sha256Hex } from '../lib/tokens.js'

export const API = '/api/v1/admin'
export const TEST_PASSWORD = 'Correct!Horse9'

// Each test signs in "from" its own IP (trust proxy = 1 honours X-Forwarded-For), so per-IP rate limits
// never leak between tests or between parallel test files.
export function randomIp(): string {
  return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
}

export async function createTestAdmin(
  overrides: { phone?: string; status?: 'active' | 'invited' | 'disabled'; superAdmin?: boolean; fullName?: string } = {},
) {
  const email = `test-${randomUUID()}@example.com`
  const admin = await db
    .insertInto('admins')
    .values({
      email,
      password_hash: await hashPassword(TEST_PASSWORD),
      full_name: overrides.fullName ?? 'Test Admin',
      status: overrides.status ?? 'active',
      is_super_admin: overrides.superAdmin ?? false,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  if (overrides.phone) {
    await db.insertInto('admin_profiles').values({ admin_id: admin.id, phone: overrides.phone }).execute()
  }
  return { id: admin.id, email, password: TEST_PASSWORD }
}

export type Session = {
  accessToken: string
  sessionId: string
  cookies: string[]
  csrf: string
  refreshCookie: string
  ip: string
}

function parseCookies(setCookie: string[] | undefined) {
  const list = setCookie ?? []
  const value = (name: string) => list.find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1) ?? ''
  return { refresh: value('gc_admin_rt'), csrf: value('gc_admin_csrf') }
}

export async function signIn(app: Express, email: string, password = TEST_PASSWORD, ip = randomIp()): Promise<Session> {
  const res = await request(app)
    .post(`${API}/auth/login`)
    .set('X-Forwarded-For', ip)
    .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')
    .send({ email, password })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
  const { refresh, csrf } = parseCookies(res.headers['set-cookie'] as unknown as string[])
  const claims = JSON.parse(Buffer.from(res.body.data.accessToken.split('.')[1], 'base64url').toString())
  return { accessToken: res.body.data.accessToken, sessionId: claims.sid, cookies: [], csrf, refreshCookie: refresh, ip }
}

export function refresh(app: Express, refreshCookie: string, csrf: string, extra: { origin?: string; ip?: string } = {}): Test {
  const req = request(app)
    .post(`${API}/auth/refresh`)
    .set('Cookie', [`gc_admin_rt=${refreshCookie}`, `gc_admin_csrf=${csrf}`])
    .set('X-CSRF-Token', csrf)
  if (extra.origin) req.set('Origin', extra.origin)
  if (extra.ip) req.set('X-Forwarded-For', extra.ip)
  return req.send({})
}

export const authed = (token: string) => ({ Authorization: `Bearer ${token}` })

export async function createResetToken(adminId: string, opts: { purpose?: 'reset' | 'invite'; expiresInMs?: number; usedAt?: Date } = {}) {
  const token = generateOpaqueToken()
  await db
    .insertInto('password_reset_tokens')
    .values({
      admin_id: adminId,
      token_hash: sha256Hex(token),
      purpose: opts.purpose ?? 'reset',
      expires_at: new Date(Date.now() + (opts.expiresInMs ?? 30 * 60_000)),
      used_at: opts.usedAt ?? null,
    })
    .execute()
  return token
}

// ---- RBAC fixtures (Admin M02) ----

import { signAccessToken } from '../lib/jwt.js'

export type TestAdmin = { id: string; email: string; token: string; sessionId: string }

// An admin with the given roles, a live session and a ready-made access token (no login round trip, so no rate limits).
export async function createAdminWithToken(opts: { roles?: string[]; superAdmin?: boolean; status?: 'active' | 'invited' | 'disabled'; fullName?: string; emailPrefix?: string } = {}): Promise<TestAdmin> {
  const email = `${opts.emailPrefix ?? 'rbac-test'}-${randomUUID()}@example.com`
  const admin = await db
    .insertInto('admins')
    .values({ email, password_hash: await hashPassword(TEST_PASSWORD), full_name: opts.fullName ?? 'RBAC Test Admin', status: opts.status ?? 'active', is_super_admin: opts.superAdmin ?? false })
    .returning(['id', 'password_changed_at'])
    .executeTakeFirstOrThrow()
  for (const code of opts.roles ?? []) {
    const role = await db.selectFrom('roles').select('id').where('code', '=', code).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
    await db.insertInto('admin_roles').values({ admin_id: admin.id, role_id: role.id }).execute()
  }
  const session = await db
    .insertInto('admin_sessions')
    .values({ admin_id: admin.id, refresh_token_hash: sha256Hex(randomUUID()), expires_at: new Date(Date.now() + 86_400_000) })
    .returning('id')
    .executeTakeFirstOrThrow()
  const token = signAccessToken({ sub: admin.id, sid: session.id, sa: opts.superAdmin ?? false, pwd: Math.floor(admin.password_changed_at.getTime() / 1000) })
  return { id: admin.id, email, token, sessionId: session.id }
}

// Removes every row the RBAC tests create. Roles are matched by name prefix, admins by e-mail prefix.
export async function purgeRbacFixtures(emailPrefix = 'rbac-test') {
  const admins = (await db.selectFrom('admins').select('id').where('email', 'like', `${emailPrefix}-%`).execute()).map((a) => a.id)
  const roles = (await db.selectFrom('roles').select('id').where('name', 'like', 'RBAC Test%').execute()).map((r) => r.id)
  if (admins.length) {
    await db.deleteFrom('admin_roles').where('admin_id', 'in', admins).execute()
    await db.deleteFrom('admin_sessions').where('admin_id', 'in', admins).execute()
    await db.deleteFrom('password_reset_tokens').where('admin_id', 'in', admins).execute()
    await db.deleteFrom('admin_profiles').where('admin_id', 'in', admins).execute()
  }
  if (roles.length) {
    await db.deleteFrom('admin_roles').where('role_id', 'in', roles).execute()
    await db.deleteFrom('roles').where('id', 'in', roles).execute()
  }
  if (admins.length) {
    await db.updateTable('admins').set({ created_by: null, updated_by: null, deleted_by: null }).where('created_by', 'in', admins).execute()
    await db.deleteFrom('admins').where('id', 'in', admins).execute()
  }
}
