import { Router } from 'express'
import type { Request } from 'express'
import { notFound } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validate.js'
import { patchSettingsSchema, settingKeySchema } from './settings.schemas.js'
import * as service from './settings.service.js'

export const settingsRouter = Router()

const ctx = (req: Request): service.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

settingsRouter.get('/settings', authenticate, requirePermission('settings.read'), async (_req, res) => {
  res.status(200).json({ data: await service.listSettings() })
})

settingsRouter.get('/settings/:key', authenticate, requirePermission('settings.read'), async (req, res) => {
  const key = settingKeySchema.safeParse(req.params.key)
  if (!key.success) throw notFound('Setting not found.')
  res.status(200).json({ data: await service.getSetting(key.data) })
})

settingsRouter.patch('/settings', authenticate, requirePermission('settings.update'), validateBody(patchSettingsSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchSettings(ctx(req), version, req.body) })
})
