import { Router } from 'express'
import type { z } from 'zod'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody, validateQuery } from '../../../middleware/validate.js'
import * as repo from './platform.repository.js'
import { areasQuerySchema, deviceBodySchema } from './platform.schemas.js'
import * as service from './platform.service.js'

export const platformRouter = Router()

platformRouter.get('/me', authenticateApp, async (req, res) => {
  res.status(200).json({ data: await service.getMe(req.appAuth!.userId) })
})

platformRouter.put('/devices/me', authenticateApp, validateBody(deviceBodySchema), async (req, res) => {
  await repo.upsertDevice(req.appAuth!.userId, req.body)
  res.status(200).json({ data: { ok: true } })
})

platformRouter.delete('/devices/me', authenticateApp, async (req, res) => {
  const installId = String(req.query.installId ?? req.header('X-Install-Id') ?? '')
  await repo.revokeDevice(req.appAuth!.userId, installId)
  res.status(200).json({ data: { ok: true } })
})

platformRouter.get('/masters', async (_req, res) => {
  res.status(200).json({ data: await service.getMasters() })
})

platformRouter.get('/masters/areas', validateQuery(areasQuerySchema), async (req, res) => {
  const { cityId } = req.validatedQuery as z.infer<typeof areasQuerySchema>
  res.status(200).json({ data: await service.getAreas(cityId) })
})
