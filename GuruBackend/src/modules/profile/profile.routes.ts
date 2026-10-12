import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { authenticate } from '../../middleware/authenticate.js'
import { validateBody } from '../../middleware/validate.js'
import { avatarSchema, changePasswordSchema, patchProfileSchema } from './profile.schemas.js'
import * as service from './profile.service.js'

// M03: self-service only. Every route acts on the signed-in admin and needs no permission key, so there is no way
// to name another admin here.
export const profileRouter = Router()

const ctx = (req: Request): service.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  sessionId: req.admin!.sessionId,
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

profileRouter.get('/me/profile', authenticate, async (req, res) => {
  res.status(200).json({ data: await service.getProfile(req.admin!.id) })
})

profileRouter.patch('/me/profile', authenticate, validateBody(patchProfileSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchProfile(ctx(req), version, req.body) })
})

profileRouter.put('/me/profile/avatar', authenticate, validateBody(avatarSchema, { firstIssueMessage: true }), async (req, res) => {
  res.status(200).json({ data: await service.setAvatar(ctx(req), req.body.fileId) })
})

profileRouter.delete('/me/profile/avatar', authenticate, async (req, res) => {
  res.status(200).json({ data: await service.removeAvatar(ctx(req)) })
})

profileRouter.post('/me/change-password', authenticate, validateBody(changePasswordSchema), async (req, res) => {
  res.status(200).json({ data: await service.changePassword(ctx(req), req.body) })
})
