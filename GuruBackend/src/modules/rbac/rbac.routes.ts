import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { notFound, validationFailed } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { adminListQuerySchema, createRoleSchema, inviteAdminSchema, patchAdminSchema, patchRoleSchema, putAdminRolesSchema, putRolePermissionsSchema, reasonBodySchema } from './rbac.schemas.js'
import * as service from './rbac.service.js'

export const rbacRouter = Router()

const ctx = (req: Request): service.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

// A malformed UUID is "not found", never a 500 (conventions section 8).
function paramId(req: Request): string {
  const parsed = z.string().uuid().safeParse(req.params.id)
  if (!parsed.success) throw notFound()
  return parsed.data
}
const optionalVersion = (req: Request) => (req.header('If-Match') ? parseIfMatch(req.header('If-Match')) : null)

rbacRouter.get('/permissions', authenticate, requirePermission('roles.read'), async (_req, res) => {
  res.status(200).json({ data: await service.listPermissions() })
})

rbacRouter.get('/roles', authenticate, requirePermission('roles.read'), async (_req, res) => {
  res.status(200).json({ data: await service.listRoles() })
})

rbacRouter.post('/roles', authenticate, requirePermission('roles.manage'), validateBody(createRoleSchema), async (req, res) => {
  res.status(201).json({ data: await service.createRole(ctx(req), req.body) })
})

rbacRouter.get('/roles/:id', authenticate, requirePermission('roles.read'), async (req, res) => {
  res.status(200).json({ data: await service.getRole(paramId(req)) })
})

rbacRouter.patch('/roles/:id', authenticate, requirePermission('roles.manage'), validateBody(patchRoleSchema), async (req, res) => {
  res.status(200).json({ data: await service.patchRole(ctx(req), paramId(req), optionalVersion(req), req.body) })
})

rbacRouter.put('/roles/:id/permissions', authenticate, requirePermission('roles.manage'), validateBody(putRolePermissionsSchema), async (req, res) => {
  const id = paramId(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.putRolePermissions(ctx(req), id, version, req.body) })
})

rbacRouter.delete('/roles/:id', authenticate, requirePermission('roles.manage'), async (req, res) => {
  await service.deleteRole(ctx(req), paramId(req))
  res.status(204).send()
})

rbacRouter.get('/admins', authenticate, requirePermission('admins.read'), validateQuery(adminListQuerySchema), async (req, res) => {
  const result = await service.listAdmins(req.validatedQuery as z.infer<typeof adminListQuerySchema>)
  res.status(200).json(result)
})

rbacRouter.post('/admins/invite', authenticate, requirePermission('admins.manage'), validateBody(inviteAdminSchema), async (req, res) => {
  res.status(201).json({ data: await service.inviteAdmin(ctx(req), req.body) })
})

rbacRouter.get('/admins/:id', authenticate, requirePermission('admins.read'), async (req, res) => {
  res.status(200).json({ data: await service.getAdmin(paramId(req)) })
})

rbacRouter.patch('/admins/:id', authenticate, requirePermission('admins.manage'), validateBody(patchAdminSchema), async (req, res) => {
  res.status(200).json({ data: await service.patchAdmin(ctx(req), paramId(req), optionalVersion(req), req.body.fullName) })
})

rbacRouter.put('/admins/:id/roles', authenticate, requirePermission('admins.manage'), validateBody(putAdminRolesSchema), async (req, res) => {
  res.status(200).json({ data: await service.putAdminRoles(ctx(req), paramId(req), req.body) })
})

rbacRouter.post('/admins/:id/resend-invite', authenticate, requirePermission('admins.manage'), async (req, res) => {
  res.status(200).json({ data: await service.resendInvite(ctx(req), paramId(req)) })
})

rbacRouter.post('/admins/:id/disable', authenticate, requirePermission('admins.manage'), validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.disableAdmin(ctx(req), paramId(req), req.body.reason) })
})

rbacRouter.post('/admins/:id/enable', authenticate, requirePermission('admins.manage'), async (req, res) => {
  res.status(200).json({ data: await service.enableAdmin(ctx(req), paramId(req)) })
})

rbacRouter.delete('/admins/:id', authenticate, requirePermission('admins.manage'), async (req, res) => {
  const parsed = reasonBodySchema.safeParse(req.body)
  if (!parsed.success) throw validationFailed(parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'reason', message: i.message })), 'Add a reason (5–500 characters).')
  await service.deleteAdmin(ctx(req), paramId(req), parsed.data.reason)
  res.status(204).send()
})
