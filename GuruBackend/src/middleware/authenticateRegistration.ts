import type { NextFunction, Request, Response } from 'express'
import { verifyRegistrationToken } from '../lib/appJwt.js'
import { authRequired } from '../lib/errors.js'

export function authenticateRegistration(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) throw authRequired()

  try {
    req.registration = verifyRegistrationToken(header.slice('Bearer '.length))
  } catch {
    throw authRequired("That took a while — let's verify your number again.")
  }

  next()
}
