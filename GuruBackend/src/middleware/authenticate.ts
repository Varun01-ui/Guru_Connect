import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/index.js'
import { authRequired, authTokenExpired } from '../lib/errors.js'
import { verifyAccessToken } from '../lib/jwt.js'
import { isSessionDenied } from '../lib/sessionDenylist.js'

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw authRequired()

  let claims
  try {
    claims = verifyAccessToken(header.slice('Bearer '.length))
  } catch (err) {
    if (err instanceof Error && err.name === 'TokenExpiredError') throw authTokenExpired()
    throw authRequired('Your session is invalid. Sign in again.')
  }

  // Fast path: a revoked session is rejected from Redis before any DB work (FR-1.4).
  if (await isSessionDenied(claims.sid)) throw authRequired('Your session ended. Sign in again.')

  const admin = await db
    .selectFrom('admins')
    .select(['id', 'email', 'status', 'is_super_admin', 'password_changed_at'])
    .where('id', '=', claims.sub)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()

  if (!admin || admin.status === 'disabled') throw authRequired('Your session is invalid. Sign in again.')

  const passwordChangedEpoch = Math.floor(new Date(admin.password_changed_at).getTime() / 1000)
  if (claims.pwd < passwordChangedEpoch) throw authRequired('Your session ended. Sign in again.')

  const session = await db
    .selectFrom('admin_sessions')
    .select(['id'])
    .where('id', '=', claims.sid)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()

  if (!session) throw authRequired('Your session ended. Sign in again.')

  req.admin = {
    id: admin.id,
    email: admin.email,
    isSuperAdmin: admin.is_super_admin,
    sessionId: claims.sid,
  }
  next()
}
