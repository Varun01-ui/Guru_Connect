import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../../lib/ifMatch.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireParent } from '../../../middleware/requireParent.js'
import { validateBody } from '../../../middleware/validate.js'
import { updateProfileSchema } from './profile.schemas.js'
import * as service from './profile.service.js'

export const profileRouter = Router()

const context = (req: Request) => ({ parentId: req.parent!.id, userId: req.parent!.userId, ip: req.ip ?? null })

profileRouter.get('/parent/profile', authenticateApp, requireParent, async (req, res) => {
  res.status(200).json({ data: await service.getProfile(context(req)) })
})

profileRouter.patch('/parent/profile', authenticateApp, requireParent, validateBody(updateProfileSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.updateProfile(context(req), version, req.body) })
})
