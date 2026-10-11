import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { ApiError, notFound } from '../errors.js'
import { getEffectivePermissions } from '../permissions.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import type { Ctx } from './kernel.js'

export const ctxOf = (req: Request): Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

// A malformed UUID is "not found", never a 500 (conventions section 8).
export function idParam(req: Request, message: string): string {
  const parsed = z.string().uuid().safeParse(req.params.id)
  if (!parsed.success) throw notFound(message)
  return parsed.data
}

// Write guard. An admin who can read the list is told so ("You can view countries but not change them."), anyone
// else gets the standard 403 that names the missing permission.
export function manageGuard(readKey: string, manageKey: string, plural: string) {
  const require = requirePermission(manageKey)
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await require(req, res, next)
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && req.admin && (await getEffectivePermissions(req.admin.id, false)).includes(readKey)) {
        throw new ApiError(403, 'FORBIDDEN', `You can view ${plural} but not change them.`, e.details)
      }
      throw e
    }
  }
}
