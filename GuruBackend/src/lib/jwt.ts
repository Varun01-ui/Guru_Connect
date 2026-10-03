import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type AccessTokenClaims = {
  sub: string
  sid: string
  sa: boolean
  pwd: number
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: 'guruconnect-admin',
    audience: 'admin-portal',
  })
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'guruconnect-admin',
    audience: 'admin-portal',
  }) as AccessTokenClaims
}
