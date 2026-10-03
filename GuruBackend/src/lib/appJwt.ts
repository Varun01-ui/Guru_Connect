import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type AppRole = 'parent' | 'student' | 'teacher' | 'institute_staff'

export type AppAccessClaims = {
  sub: string
  role: AppRole
  pid: string
  // institute id, institute staff only
  iid?: string
  sid: string
}

export type RegistrationContactType = 'phone' | 'email' | 'google'

export type RegistrationClaims = {
  sub: string
  contactType: RegistrationContactType
  prefill?: { fullName?: string; photoUrl?: string }
  jti: string
}

export function signAppAccessToken(claims: AppAccessClaims): string {
  return jwt.sign(claims, env.APP_JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'gc-app',
    expiresIn: env.APP_ACCESS_TOKEN_TTL_SECONDS,
  })
}

export function verifyAppAccessToken(token: string): AppAccessClaims {
  return jwt.verify(token, env.APP_JWT_SECRET, { algorithms: ['HS256'], audience: 'gc-app' }) as AppAccessClaims
}

export function signRegistrationToken(claims: Omit<RegistrationClaims, 'jti'>): { token: string; jti: string } {
  const jti = randomUUID()
  const token = jwt.sign({ ...claims, jti }, env.APP_JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'gc-register',
    expiresIn: env.APP_REGISTRATION_TOKEN_TTL_SECONDS,
  })
  return { token, jti }
}

export function verifyRegistrationToken(token: string): RegistrationClaims {
  return jwt.verify(token, env.APP_JWT_SECRET, { algorithms: ['HS256'], audience: 'gc-register' }) as RegistrationClaims
}
