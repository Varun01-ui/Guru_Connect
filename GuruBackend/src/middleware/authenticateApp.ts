import type { NextFunction, Request, Response } from 'express'
import { verifyAppAccessToken } from '../lib/appJwt.js'
import { authRequired, authTokenExpired } from '../lib/errors.js'

export function authenticateApp(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw authRequired()

  let claims
  try {
    claims = verifyAppAccessToken(header.slice('Bearer '.length))
  } catch (err) {
    if (err instanceof Error && err.name === 'TokenExpiredError') throw authTokenExpired()
    throw authRequired('Your session has expired. Please sign in again.')
  }

  req.appAuth = { userId: claims.sub, role: claims.role, profileId: claims.pid || null, instituteId: claims.iid ?? null, sessionId: claims.sid }
  next()
}
