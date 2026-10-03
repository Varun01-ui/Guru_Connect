import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/index.js'
import { forbidden } from '../lib/errors.js'

// Runs after authenticateApp on every /parent/* and /home/parent route. Resolves the parent profile id from the
// token's `pid` claim (falling back to a lookup if the token was minted before the profile existed) and stores it on
// the request, so handlers scope by it and never accept a parentId from the body or query.
export async function requireParent(req: Request, _res: Response, next: NextFunction) {
  const auth = req.appAuth
  if (!auth || auth.role !== 'parent') throw forbidden("You can't do that.")

  let parentId = auth.profileId
  if (!parentId) {
    const row = await db.selectFrom('parents').select('id').where('user_id', '=', auth.userId).where('deleted_at', 'is', null).executeTakeFirst()
    parentId = row?.id ?? null
  }
  if (!parentId) throw forbidden("You can't do that.")

  req.parent = { id: parentId, userId: auth.userId }
  next()
}
