import type { NextFunction, Request, Response } from 'express'
import { ApiError, authRequired } from '../lib/errors.js'
import { getEffectivePermissions } from '../lib/permissions.js'

const denied = (required: string[]) => new ApiError(403, 'FORBIDDEN', "You don't have permission to do that.", { required })

// Passes when the admin holds ANY of the keys (FR-2.6). Super admins pass every check.
export function requirePermission(...keys: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.admin
    if (!admin) throw authRequired()
    if (admin.isSuperAdmin) return next()
    const held = new Set(await getEffectivePermissions(admin.id, false))
    if (!keys.some((k) => held.has(k))) throw denied(keys)
    next()
  }
}

// Passes only when the admin holds ALL of the keys.
export function requireAllPermissions(...keys: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.admin
    if (!admin) throw authRequired()
    if (admin.isSuperAdmin) return next()
    const held = new Set(await getEffectivePermissions(admin.id, false))
    const missing = keys.filter((k) => !held.has(k))
    if (missing.length > 0) throw denied(missing)
    next()
  }
}
